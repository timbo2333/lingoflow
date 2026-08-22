# Backup v2 Format Specification

## 1. Purpose

Backup Format is a long-term contract for understanding backup data, not a storage or recovery implementation.

Backup Format describes what the backup represents.

---

## 2. Backup Format Responsibilities

Backup Format defines:

- backup identity;
- versioning;
- included scope;
- compatibility information.

---

## 3. Related Layer Responsibilities

### Backup Schema

Defines:

- whether contained entities are structurally safe;
- whether required fields and data relationships are valid.

### Export / Restore Orchestration

Defines:

- how data moves between backup payloads and application workflows;
- how validation, evaluation and restoration steps are coordinated.

### Domain Libraries

Define:

- local entity rules;
- identity handling;
- lifecycle semantics;
- safe persistence boundaries.

### Local Persistence

Defines:

- actual storage implementation.

Backup Format must remain independent from local persistence details.

---

## 4. Versioning Principles

Backup Format version must be independent from:

- Application version.
- Database version.
- Storage implementation version.

A new application release does not automatically require a new Backup Format version.

Format changes should only occur when one of the following changes:

- the meaning of existing backup data;
- the interpretation rules;
- the compatibility boundary;
- the entity scope definition.

Backup Format versioning should describe backup meaning, not software release history.

---

## 5. Entity Scope

Backup Format should explicitly describe which entities are included.

Entities should be classified according to their data ownership and reconstruction characteristics.

---

### 5.1 Personal Data

Personal Data represents user-owned information that cannot be easily reconstructed.

Examples:

- Articles.
- Reading Progress.
- Favorites.
- Query Events.
- Portable Preferences.

Personal Data requires protection of:

- stable identity;
- user-created content;
- lifecycle information;
- meaningful user state.

Missing Personal Data from a backup scope should be explicitly declared.

---

### 5.2 Derived Data

Derived Data represents information calculated from other user data.

Examples:

- Aggregated vocabulary statistics.
- Cached summaries.
- Computed indexes.

Derived Data:

- should not replace original facts;
- may be rebuilt from source data;
- should not become the only representation of user history.

When both source data and derived data exist, source data remains authoritative.

---

### 5.3 Rebuildable Resources

Rebuildable Resources represent resources that can be recreated independently.

Examples:

- Dictionary data.
- Lemma mappings.

Rebuildable Resources:

- are not equivalent to Personal Data;
- should remain separate from user asset protection;
- should not affect whether personal backup is considered complete.

Including rebuildable resources does not compensate for missing personal data.

---

## 6. Format Boundaries

Backup Format should not define:

- IndexedDB structure.
- localStorage keys.
- Database names.
- Object store names.
- File system paths.
- UI behavior.
- Cloud synchronization protocols.
- Account systems.

Backup Format should not decide:

- which version wins during conflicts;
- whether records should be merged;
- whether existing data should be overwritten;
- how migrations are performed.

These decisions belong to higher-level recovery and migration processes.

---

## 7. Forward Compatibility

Backup Format should allow future versions of LingoFlow to introduce:

- new entities;
- new metadata;
- new compatibility information.

Future changes must not silently change the meaning of existing backup data.

Unknown but valid fields should follow the compatibility rules defined by the corresponding schema.

Unsupported entities should be:

- clearly identified;
- handled according to compatibility rules;
- not silently ignored.

---

## 8. Recovery Boundary

A valid Backup Format does not guarantee successful restoration.

Successful restoration requires multiple independent checks:

- Format validation.
- Entity schema validation.
- Domain-level validation.
- Local conflict evaluation.
- Safe write operations.

Backup Format describes what the backup represents.

It does not guarantee:

- that all entities can be restored;
- that conflicts do not exist;
- that local data can be replaced safely.

The final restoration result depends on validation and domain rules.

---

## 9. Design Principles Summary

Backup Format follows these principles:

- Separate backup meaning from application implementation.
- Separate personal data from rebuildable resources.
- Preserve future compatibility.
- Avoid embedding storage details.
- Avoid defining conflict resolution rules.
- Avoid assuming restoration success from backup validity.

Backup Format is a long-term contract for understanding backup data, not a storage or recovery implementation.
