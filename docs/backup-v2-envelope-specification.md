# Backup v2 Envelope Specification

## 1. Purpose

Backup Envelope defines the outer structure of a LingoFlow backup payload.

It describes how backup data is packaged, identified, and interpreted before entity-level validation.

The Envelope provides a stable boundary between:

- Backup file representation.
- Backup entity schemas.
- Export and Restore workflows.

The Envelope does not define:

- Entity storage rules.
- Domain validation rules.
- Conflict resolution behavior.
- Migration strategies.

---

## 2. Responsibilities

Backup Envelope is responsible for:

- Identifying the application that created the backup.
- Identifying the backup format version.
- Providing schema version information.
- Recording backup metadata.
- Declaring included entity collections.
- Providing compatibility information.

The Envelope allows future versions of LingoFlow to determine:

- Whether this backup belongs to LingoFlow.
- Which format rules should be applied.
- Which entities are contained.
- Whether the current application can process the backup.

---

## 3. Relationship With Backup Layers

The backup architecture is:

Backup Envelope
    ↓
Backup Schema
    ↓
Domain Libraries
    ↓
Local Persistence

Responsibilities:

- Backup Envelope describes the backup container.
- Backup Schema validates entity structure.
- Export and Restore modules move backup data.
- Domain libraries enforce application rules.
- Local persistence stores data.

Each layer should only handle its own responsibility.

---

## 4. Envelope Structure

The Backup Envelope should contain:

```json
{
  "format": {},
  "metadata": {},
  "schema": {},
  "data": {}
}
format
Describes backup identity and version.
Example:
{
  "name": "LingoFlow Backup",
  "version": 2
}
metadata
Contains backup-level information.
Examples:
- Export time.
- Application information.
- Generator information.
Metadata should not contain user data.
schema
Describes entity schema versions.
Example:
{
  "articles": "1"
}
Schema versions are independent from:
- Application version.
- Database version.
- Storage version.
data
Contains actual backup entities.
Example:
{
  "articles": []
}
Entity data must follow the corresponding Backup Schema rules.
5. Versioning Rules
Backup Envelope version changes only when the meaning or interpretation of the outer structure changes.
The following do not automatically require a new Envelope version:
- Application updates.
- UI changes.
- Database migrations.
- Internal implementation changes.
A new Envelope version is required when:
- Existing fields change meaning.
- Required fields change.
- Compatibility rules change.
- Backup interpretation changes.
6. Compatibility Principles
Backup Envelope should support future extension.
Rules:
- Unknown valid fields should not break reading.
- Unsupported entities should be explicitly identified.
- Existing fields must keep stable meaning.
- Removing or changing field meaning requires version changes.
7. Security Boundaries
Backup Envelope validation does not guarantee safe restoration.
A valid Envelope only means:
- The container structure is recognized.
- Metadata is readable.
- Declared entities can be located.
Safe restoration still requires:
- Schema validation.
- Domain validation.
- Conflict evaluation.
- Safe write operations.
8. Design Summary
Backup Envelope is a long-term contract describing how LingoFlow backup data is packaged.
It separates:
- Backup identity from application implementation.
- Container structure from entity rules.
- Backup validity from restoration success.
Backup Envelope defines what the backup represents, not how the application stores or restores it.