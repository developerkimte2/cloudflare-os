import type {
  AIContextSnapshot, AIDecision, Activity, AuditLog, CalendarEventMirror, Commitment,
  CustomerAccount, CustomerPerson, ExternalIdentity, NextAction, NotificationLog, Opportunity,
  ReviewItem, SourceApplication, SourceDocument, User,
} from "../domain/types.js";
import { Table, col } from "./mapper.js";

export const users = new Table<User>("users", "id", [
  col("id", "id"), col("email", "email"), col("display_name", "displayName"), col("role", "role"),
  col("manager_user_id", "managerUserId"), col("timezone", "timezone"),
  col("active", "active", "bool"), col("created_at", "createdAt"), col("updated_at", "updatedAt"),
]);

export const externalIdentities = new Table<ExternalIdentity>("external_identities", "external_id", [
  col("provider", "provider"), col("external_id", "externalId"), col("user_id", "userId"),
  col("created_at", "createdAt"),
]);

export const customerAccounts = new Table<CustomerAccount>("customer_accounts", "id", [
  col("id", "id"), col("display_name", "displayName"), col("normalized_name", "normalizedName"),
  col("primary_domain", "primaryDomain"), col("address", "address"), col("phone", "phone"),
  col("website_url", "websiteUrl"), col("external_provider", "externalProvider"),
  col("external_account_id", "externalAccountId"), col("resolution_status", "resolutionStatus"),
  col("created_at", "createdAt"), col("updated_at", "updatedAt"),
]);

export const customerPersons = new Table<CustomerPerson>("customer_persons", "id", [
  col("id", "id"), col("account_id", "accountId"), col("display_name", "displayName"),
  col("normalized_name", "normalizedName"), col("email", "email"), col("phone", "phone"),
  col("title", "title"), col("external_provider", "externalProvider"),
  col("external_person_id", "externalPersonId"), col("resolution_status", "resolutionStatus"),
  col("created_at", "createdAt"), col("updated_at", "updatedAt"),
]);

export const opportunities = new Table<Opportunity>("opportunities", "id", [
  col("id", "id"), col("account_id", "accountId"), col("title", "title"),
  col("owner_user_id", "ownerUserId"), col("collaborator_user_ids", "collaboratorUserIds", "json"),
  col("lifecycle_state", "lifecycleState"), col("operational_state", "operationalState"),
  col("phase_label", "phaseLabel"), col("expected_amount", "expectedAmount"),
  col("currency", "currency"), col("expected_close_date", "expectedCloseDate"),
  col("proposal_document_url", "proposalDocumentUrl"),
  col("contact_person_ids", "contactPersonIds", "json"),
  col("next_action_id", "nextActionId"),
  col("last_meaningful_activity_at", "lastMeaningfulActivityAt"),
  col("last_context_recomputed_at", "lastContextRecomputedAt"), col("risk_level", "riskLevel"),
  col("risk_reason", "riskReason"), col("version", "version"), col("created_at", "createdAt"),
  col("updated_at", "updatedAt"),
]);

export const sourceDocuments = new Table<SourceDocument>("source_documents", "id", [
  col("id", "id"), col("source_type", "sourceType"), col("external_id", "externalId"),
  col("submitted_by_user_id", "submittedByUserId"), col("r2_object_key", "r2ObjectKey"),
  col("raw_text", "rawText"), col("content_hash", "contentHash"), col("occurred_at", "occurredAt"),
  col("received_at", "receivedAt"), col("processing_status", "processingStatus"),
  col("processing_error", "processingError"), col("processed_at", "processedAt"),
]);

export const activities = new Table<Activity>("activities", "id", [
  col("id", "id"), col("opportunity_id", "opportunityId"), col("account_id", "accountId"),
  col("person_ids", "personIds", "json"), col("actor_user_ids", "actorUserIds", "json"),
  col("type", "type"), col("occurred_at", "occurredAt"), col("source_id", "sourceId"),
  col("summary", "summary"), col("facts_json", "factsJson", "json"),
  col("questions_json", "questionsJson", "json"), col("objections_json", "objectionsJson", "json"),
  col("commitments_json", "commitmentsJson", "json"), col("decisions_json", "decisionsJson", "json"),
  col("ai_confidence", "aiConfidence"), col("created_at", "createdAt"),
]);

export const commitments = new Table<Commitment>("commitments", "id", [
  col("id", "id"), col("opportunity_id", "opportunityId"), col("side", "side"),
  col("owner_person_id", "ownerPersonId"), col("owner_user_id", "ownerUserId"),
  col("description", "description"), col("due_at", "dueAt"), col("status", "status"),
  col("source_evidence_id", "sourceEvidenceId"), col("created_at", "createdAt"),
  col("updated_at", "updatedAt"),
]);

export const nextActions = new Table<NextAction>("next_actions", "id", [
  col("id", "id"), col("opportunity_id", "opportunityId"), col("assigned_user_id", "assignedUserId"),
  col("action_type", "actionType"), col("title", "title"), col("purpose", "purpose"),
  col("due_at", "dueAt"), col("recommended_at", "recommendedAt"), col("priority", "priority"),
  col("status", "status"), col("snoozed_until", "snoozedUntil"), col("generated_by", "generatedBy"),
  col("source_decision_id", "sourceDecisionId"), col("created_at", "createdAt"),
  col("updated_at", "updatedAt"),
]);

export const calendarEventMirrors = new Table<CalendarEventMirror>("calendar_event_mirrors", "id", [
  col("id", "id"), col("google_calendar_id", "googleCalendarId"),
  col("google_event_id", "googleEventId"), col("owner_user_id", "ownerUserId"), col("title", "title"),
  col("description", "description"), col("attendees_json", "attendeesJson", "json"),
  col("organizer_email", "organizerEmail"), col("meeting_url", "meetingUrl"),
  col("start_at", "startAt"), col("end_at", "endAt"), col("status", "status"),
  col("account_id", "accountId"), col("opportunity_id", "opportunityId"),
  col("resolution_confidence", "resolutionConfidence"), col("etag", "etag"),
  col("last_synced_at", "lastSyncedAt"),
]);

export const aiContextSnapshots = new Table<AIContextSnapshot>("ai_context_snapshots", "id", [
  col("id", "id"), col("opportunity_id", "opportunityId"),
  col("current_situation", "currentSituation"), col("latest_development", "latestDevelopment"),
  col("customer_intent", "customerIntent"), col("decided_json", "decidedJson", "json"),
  col("unresolved_json", "unresolvedJson", "json"), col("risks_json", "risksJson", "json"),
  col("commitments_json", "commitmentsJson", "json"),
  col("recommended_actions_json", "recommendedActionsJson", "json"),
  col("evidence_ids_json", "evidenceIdsJson", "json"), col("model_provider", "modelProvider"),
  col("model_name", "modelName"), col("prompt_version", "promptVersion"),
  col("schema_version", "schemaVersion"), col("confidence_json", "confidenceJson", "json"),
  col("created_at", "createdAt"),
]);

export const aiDecisions = new Table<AIDecision>("ai_decisions", "id", [
  col("id", "id"), col("entity_type", "entityType"), col("entity_id", "entityId"),
  col("decision_type", "decisionType"), col("input_source_ids_json", "inputSourceIds", "json"),
  col("proposed_json", "proposedJson", "json"), col("applied_json", "appliedJson", "json"),
  col("confidence", "confidence"), col("status", "status"),
  col("reasoning_summary", "reasoningSummary"), col("evidence_json", "evidenceJson", "json"),
  col("model_name", "modelName"), col("prompt_version", "promptVersion"),
  col("created_at", "createdAt"),
]);

export const reviewItems = new Table<ReviewItem>("review_items", "id", [
  col("id", "id"), col("type", "type"), col("assigned_user_id", "assignedUserId"),
  col("related_entity_type", "relatedEntityType"), col("related_entity_id", "relatedEntityId"),
  col("question", "question"), col("options_json", "optionsJson", "json"),
  col("source_evidence_ids_json", "sourceEvidenceIds", "json"), col("status", "status"),
  col("resolution_json", "resolutionJson", "json"), col("created_at", "createdAt"),
  col("resolved_at", "resolvedAt"),
]);

export const auditLogs = new Table<AuditLog>("audit_logs", "id", [
  col("id", "id"), col("actor_type", "actorType"), col("actor_id", "actorId"),
  col("action", "action"), col("entity_type", "entityType"), col("entity_id", "entityId"),
  col("before_json", "beforeJson", "json"), col("after_json", "afterJson", "json"),
  col("source_ids_json", "sourceIds", "json"), col("ai_decision_id", "aiDecisionId"),
  col("created_at", "createdAt"),
]);

export const notificationLogs = new Table<NotificationLog>("notification_logs", "id", [
  col("id", "id"), col("user_id", "userId"), col("channel", "channel"),
  col("notification_type", "notificationType"), col("entity_type", "entityType"),
  col("entity_id", "entityId"), col("message_hash", "messageHash"), col("sent_at", "sentAt"),
  col("status", "status"),
]);

export const sourceApplications = new Table<SourceApplication>("source_applications", "source_id", [
  col("source_id", "sourceId"), col("opportunity_id", "opportunityId"),
  col("activity_id", "activityId"),
  col("created_commitment_ids", "createdCommitmentIds", "json"),
  col("created_next_action_ids", "createdNextActionIds", "json"),
  col("created_review_ids", "createdReviewIds", "json"),
  col("created_account_id", "createdAccountId"),
  col("created_person_ids", "createdPersonIds", "json"),
  col("created_opportunity", "createdOpportunity", "bool"), col("snapshot_id", "snapshotId"),
  col("opportunity_before_json", "opportunityBefore", "json"),
  col("decision_ids", "decisionIds", "json"), col("applied_at", "appliedAt"),
  col("reverted_at", "revertedAt"),
]);
