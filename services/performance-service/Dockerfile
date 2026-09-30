# Stage 1: Build Jar
FROM maven:3.9.16-amazoncorretto-17 AS builder
WORKDIR /app
COPY services/atlas-common/pom.xml services/atlas-common/pom.xml
COPY services/atlas-common/src services/atlas-common/src
RUN mvn install -f services/atlas-common/pom.xml -DskipTests
COPY services/performance-service/pom.xml services/performance-service/pom.xml
RUN mvn dependency:go-offline -f services/performance-service/pom.xml || true
COPY services/performance-service/src services/performance-service/src
RUN mvn clean package -f services/performance-service/pom.xml -DskipTests

# Stage 2: Minimal Runtime JRE
FROM amazoncorretto:17-alpine
WORKDIR /app
COPY --from=builder /app/services/performance-service/target/performance-service-0.0.1-SNAPSHOT.jar performance-service.jar

# Run as non-root to match k8s runAsUser 1001 (runAsNonRoot).
# Writable tmp dir for the JVM, picked up via JAVA_TOOL_OPTIONS.
RUN addgroup -S -g 1001 appgroup && \
    adduser -S -u 1001 -G appgroup -h /home/appuser appuser && \
    mkdir -p /app/tmp && \
    chown -R appuser:appgroup /app /home/appuser

ENV JAVA_TOOL_OPTIONS="-Djava.io.tmpdir=/app/tmp"

EXPOSE 8014

USER appuser

ENTRYPOINT ["java", "-jar", "performance-service.jar"]
