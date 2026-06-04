# From Prototype to Enterprise Scale

The `ems-handoff-app` is a deployed, functional single-tenant implementation of the EMS-to-ED data pipeline — one EMS crew, one hospital, one emergency department.

The enterprise extension of this prototype is documented in a separate repository: **[Enterprise Healthcare Interoperability Middleware Design](https://github.com/jyoum3/enterprise-healthcare-interoperability-middleware-design)**.

---

## What the Enterprise Design Covers

The enterprise repo documents what it takes to run this same pipeline at city scale — multiple EMS agencies routing to multiple hospital systems and emergency departments on shared infrastructure, with strict per-tenant PHI isolation.

Four architecture diagrams document the system from different angles:

- **1:1 ETL Pipeline** — The baseline: one EMS agency to one emergency department, with full FHIR validation, Azure Service Bus pub/sub, and AWS S3 HIPAA compliance archive.
- **M:M ETL Pipeline** — Multi-tenant routing: per-hospital Service Bus topics, per-ED SQL filter subscriptions, and FHIR resource tagging enforcing data isolation at every layer of the stack.
- **Zero Trust Security Posture** — Private-by-default VNet topology with private endpoints on all PaaS services, CMK encryption at rest via Azure Key Vault, system-assigned Managed Identity RBAC, and Azure Policy guardrails enforced at the management group level.
- **AWS Disaster Recovery** — Three-tier cross-cloud standby: always-active S3 Object Lock HIPAA compliance archive, Route 53 health-check failover (~2.5 min RTO) to a pre-provisioned Lambda/SQS/HealthLake pipeline, and a Phase 2 dashboard continuity layer using AWS Amplify and Amazon Cognito.

---

## Relationship to This Prototype

The enterprise architecture takes the core patterns established in this codebase — schema validation via Pydantic, idempotent Cosmos DB writes, Change Feed streaming to SignalR, write-before-delete PHI lifecycle — and documents the infrastructure required to operate them at production scale across a multi-tenant healthcare environment.

→ **[Enterprise Healthcare Interoperability Middleware Design](https://github.com/jyoum3/enterprise-healthcare-interoperability-middleware-design)**
