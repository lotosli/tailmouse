# Hosted configuration defaults

## ADDED Requirements

### Requirement: Hosted sharing without a local configuration file

The four resource commands MUST use `https://tailmouse.com` for their hosted frontend and content origins, with the existing trusted-app same-origin mode, when neither origin is configured. They MUST NOT download or create a local configuration file to obtain these defaults. Explicit test-mode configuration MUST take precedence. Session limits, approval rules, resource validation and legacy Escape/Leash defaults MUST remain unchanged.

#### Scenario: Start with only a resource argument

- **WHEN** a host has no configuration file or deployment overrides and runs a valid CLI, Web, Receive or Dev command
- **THEN** parsing succeeds with the hosted deployment and existing resource limits
- **AND** a port-only Web target still refers to `127.0.0.1` on the sharing machine.

### Requirement: Explicit deployments retain strict configuration

Flags MUST override environment, environment MUST override files, and files MUST override defaults. Configuring either origin MUST disable implicit hosted content/test-mode selection. Explicit missing or malformed files MUST fail before resource startup. Custom Web origins MUST satisfy the existing isolation or explicit test-mode validation.

#### Scenario: Keep a self-hosted origin policy

- **WHEN** a user provides custom origins or explicitly disables test mode
- **THEN** their values are validated without silently enabling hosted same-origin mode
- **AND** incompatible or incomplete Web deployment options fail.

### Requirement: Short commands in matching release guidance

The homepage, README and CLI help MUST show the configuration-free hosted commands and identify the matching downloadable version. Advanced users MUST retain access to custom configuration guidance. Documentation MUST retain actual platform and trusted-app limitations.

#### Scenario: Follow the first-share guide

- **WHEN** a user follows the Receive guide with the matching supported native build
- **THEN** they create a receiving folder and start sharing without first fetching a deployment file.
