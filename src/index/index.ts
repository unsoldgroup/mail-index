/** Index layer barrel (SCOPE 0.2). */
export { openDb, defaultDbPath, IndexError, type OpenOptions } from './db.js';
export type {
  StorageDriver,
  PreparedStatement,
  BatchStatement,
  SqlParam,
  RunResult,
} from './driver.js';
export { SqliteDriver } from './drivers/sqlite.js';
export { runMigrations, getUserVersion, MIGRATIONS, type Migration } from './migrations.js';
export { Repo } from './repo.js';
export type {
  MessageInput,
  MessageRow,
  ContactInput,
  DomainCategoryInput,
  MessageSummaryInput,
  ThreadSummaryInput,
  CompactCandidateRow,
  CategorizeCandidateRow,
  CategorizeSample,
  SyncRunStart,
  SyncRunFinish,
  AggregationMessageRow,
  ContactAggregate,
  DomainAggregate,
  ThreadAggregate,
  ContactRow,
  DomainRow,
  ThreadRow,
  ContactScoringRow,
  ScoredContactInput,
  GraphThread,
  GraphMetricInput,
  CurationContactRow,
  CurationDomainRow,
  InterestProfileRow,
  ContactDetailRow,
  ContactSort,
  ContactListFilter,
  GraphNeighborRow,
} from './repo.js';
export {
  SCHEMA_VERSION,
  BODY_STATES,
  BODY_STATE_RANK,
  CATEGORIES,
  CURATIONS,
  DIRECTIONS,
  SYNC_PHASES,
  type BodyState,
  type Category,
  type Curation,
  type Direction,
  type SyncPhase,
} from './schema.js';
