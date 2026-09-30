FROM maven:3.9.16-amazoncorretto-17 AS builder
WORKDIR /app
COPY services/atlas-common/pom.xml services/atlas-common/pom.xml
COPY services/atlas-common/src services/atlas-common/src
RUN mvn install -f services/atlas-common/pom.xml -DskipTests
COPY services/payroll-java-service/pom.xml services/payroll-java-service/pom.xml
COPY services/payroll-java-service/src services/payroll-java-service/src
RUN mvn clean package -f services/payroll-java-service/pom.xml -DskipTests

FROM amazoncorretto:17-alpine
WORKDIR /app
COPY --from=builder /app/services/payroll-java-service/target/payroll-service-*.jar app.jar

# Run as non-root to match k8s runAsUser 1001 (runAsNonRoot).
# Writable tmp dir for the JVM, picked up via JAVA_TOOL_OPTIONS.
RUN addgroup -S -g 1001 appgroup && \
    adduser -S -u 1001 -G appgroup -h /home/appuser appuser && \
    mkdir -p /app/tmp && \
    chown -R appuser:appgroup /app /home/appuser

ENV JAVA_TOOL_OPTIONS="-Djava.io.tmpdir=/app/tmp"

EXPOSE 8002

USER appuser

ENTRYPOINT ["java", "-jar", "app.jar"]
