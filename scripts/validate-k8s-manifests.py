"""Fail CI when the k8s manifests cannot deploy.

Catches the exact class of bug from issue #193: Deployments referencing a
Secret/ConfigMap that does not exist in k8s/, floating :latest image tags,
and datastores without a NetworkPolicy. Runs on stdlib + pyyaml only.
"""
import glob
import os
import re
import sys

import yaml

K8S_DIR = os.environ.get(
    "K8S_MANIFESTS_DIR",
    os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "k8s"),
)

REQUIRED_SECRET_KEYS = {
    "JWT_SECRET", "INTERNAL_JWT_SECRET", "MFA_STEPUP_SECRET",
    "ADMIN_DEFAULT_PASSWORD", "SCIM_API_KEY", "SAML_IDP_CERT",
    "OAUTH_ENCRYPTION_KEY", "AUDIT_INTERNAL_KEY", "SECURITY_INTERNAL_KEY",
    "SLACK_SIGNING_SECRET", "SLACK_WEBHOOK_SECRET", "OPENAI_API_KEY",
    "POSTGRES_PASSWORD", "MONGO_PASSWORD", "RABBITMQ_PASSWORD",
    "REDIS_PASSWORD", "DB_PASSWORD", "SPRING_DATASOURCE_PASSWORD",
    "SPRING_RABBITMQ_PASSWORD", "DATABASE_URL", "POSTGRES_URL", "MONGO_URL",
    "RABBITMQ_URL", "REDIS_URL",
    "postgres-user", "postgres-password", "mongo-user", "mongo-password",
    "redis-password", "rabbitmq-password",
}

REQUIRED_CONFIG_KEYS = {
    "NODE_ENV", "ALLOWED_ORIGINS", "AUTH_SERVICE_URL", "AUDIT_SERVICE_URL",
    "KAFKA_BOOTSTRAP_SERVERS", "POSTGRES_USER", "POSTGRES_DB",
}

# Deployments that must load backend secrets (frontend is static, needs none).
SECRETLESS_DEPLOYMENTS = {"frontend"}

# Datastore pod labels that must be covered by a NetworkPolicy.
DATASTORE_APPS = {"postgres", "mongodb", "redis", "rabbitmq", "kafka", "zookeeper"}

errors = []


def fail(msg):
    errors.append(msg)


def load_docs():
    docs = []
    for path in sorted(glob.glob(os.path.join(K8S_DIR, "*.yaml"))):
        with open(path) as fh:
            for doc in yaml.safe_load_all(fh):
                if doc:
                    docs.append((os.path.basename(path), doc))
    return docs


def main():
    docs = load_docs()
    if not docs:
        fail("no manifests found under k8s/")
        raise SystemExit(1)

    secrets = {}
    configmaps = {}
    deployments = []
    netpol_targets = set()

    for fname, doc in docs:
        kind = doc.get("kind")
        name = (doc.get("metadata") or {}).get("name", "?")
        if kind == "Secret":
            secrets[name] = {**(doc.get("data") or {}), **(doc.get("stringData") or {})}
        elif kind == "ConfigMap":
            configmaps[name] = doc.get("data") or {}
        elif kind == "Deployment":
            deployments.append((fname, doc))
        elif kind == "NetworkPolicy":
            selector = ((doc.get("spec") or {}).get("podSelector") or {}).get("matchLabels") or {}
            if "app" in selector:
                netpol_targets.add(selector["app"])

    if "atlas-secrets" not in secrets:
        fail("no Secret named atlas-secrets in k8s/ (all Deployments use envFrom secretRef atlas-secrets)")
    else:
        missing = REQUIRED_SECRET_KEYS - set(secrets["atlas-secrets"])
        if missing:
            fail(f"atlas-secrets is missing keys: {sorted(missing)}")

    if "atlas-config" not in configmaps:
        fail("no ConfigMap named atlas-config in k8s/")
    else:
        missing = REQUIRED_CONFIG_KEYS - set(configmaps["atlas-config"])
        if missing:
            fail(f"atlas-config is missing keys: {sorted(missing)}")

    for fname, dep in deployments:
        name = (dep.get("metadata") or {}).get("name", "?")
        containers = (((dep.get("spec") or {}).get("template") or {}).get("spec") or {}).get("containers") or []
        if not containers:
            fail(f"{fname} Deployment/{name} has no containers")
            continue
        is_app = any((c.get("image") or "").startswith("ghcr.io/senthil455/") for c in containers)
        for container in containers:
            image = container.get("image", "")
            if not is_app:
                continue
            if image.endswith(":latest") or ":" not in image.split("/")[-1]:
                fail(f"{fname} Deployment/{name} uses floating image tag: {image}")
            if container.get("imagePullPolicy") != "IfNotPresent":
                fail(f"{fname} Deployment/{name} container {container.get('name')} must set imagePullPolicy: IfNotPresent")
            if not container.get("resources"):
                fail(f"{fname} Deployment/{name} container {container.get('name')} has no resources")
        if not is_app or name in SECRETLESS_DEPLOYMENTS:
            continue
        env_from = []
        for container in containers:
            env_from.extend(container.get("envFrom") or [])
        refs = {(e.get("secretRef") or {}).get("name") for e in env_from}
        refs |= {(e.get("configMapRef") or {}).get("name") for e in env_from}
        if "atlas-secrets" not in refs:
            fail(f"{fname} Deployment/{name} does not load envFrom secretRef atlas-secrets")
        if "atlas-config" not in refs:
            fail(f"{fname} Deployment/{name} does not load envFrom configMapRef atlas-config")
        for container in containers:
            for var in container.get("env") or []:
                ref = (var.get("valueFrom") or {}).get("secretKeyRef") or {}
                if ref and ref.get("name") == "atlas-secrets":
                    if ref.get("key") not in secrets.get("atlas-secrets", {}):
                        fail(f"{fname} Deployment/{name} references missing secret key: {ref.get('key')}")

    # every secretKeyRef anywhere must resolve
    for fname, doc in docs:
        kind = doc.get("kind")
        if kind in ("Secret", "ConfigMap"):
            continue
        text_refs = []

        def walk(node):
            if isinstance(node, dict):
                ref = node.get("secretKeyRef")
                if isinstance(ref, dict) and ref.get("name"):
                    text_refs.append(ref)
                for value in node.values():
                    walk(value)
            elif isinstance(node, list):
                for value in node:
                    walk(value)

        walk(doc.get("spec"))
        for ref in text_refs:
            if ref["name"] not in secrets:
                fail(f"{fname} references Secret {ref['name']} which does not exist in k8s/")
            elif not ref.get("optional") and ref.get("key") not in secrets.get(ref["name"], {}):
                fail(f"{fname} references missing key {ref['key']} in Secret {ref['name']}")

    uncovered = DATASTORE_APPS - netpol_targets
    if uncovered:
        fail(f"datastore pods without a NetworkPolicy: {sorted(uncovered)}")

    if errors:
        print("k8s manifest validation FAILED:")
        for msg in errors:
            print(f"  - {msg}")
        raise SystemExit(1)
    print(f"k8s manifests OK ({len(deployments)} Deployments, secret+config present, images pinned, datastores covered)")


if __name__ == "__main__":
    main()
