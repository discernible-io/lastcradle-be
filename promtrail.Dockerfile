FROM grafana/promtail:latest

# Create a non-root user to run Promtail
RUN adduser -D promtail
USER promtail

# Copy the config file
COPY /promtrail/promtail-config.yml /etc/promtail/config.yml

# Expose the HTTP port that Promtail uses
EXPOSE 9080

# Use the entrypoint from the base image
ENTRYPOINT ["/usr/bin/promtail"]

# Run with the config
CMD ["-config.file=/etc/promtail/config.yml"]