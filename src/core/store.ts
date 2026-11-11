import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { MemoryRepository } from './memory.ts'
import { FeedRepository } from './feed.ts'
import { AutonomyRepository } from './autonomy.ts'
import { SelfNoteRepository } from './self-note.ts'
import { MediaRepository } from './media.ts'
import { GameLearningRepository } from './game-learning.ts'
import { BilibiliQueueRepository } from './bilibili-queue.ts'
import { BilibiliSubtitleRepository } from './bilibili-subtitles.ts'
import { DeviceNoticeRepository } from './notices.ts'
import { MinecraftHouseRepository } from './minecraft-house-repository.ts'
import { MinecraftHouseProjectRepository } from './minecraft-house-project-repository.ts'
import { MinecraftPlaceRepository } from './minecraft-place-repository.ts'
import { MAX_SONG_VOCAL_SAMPLES } from '../protocol/singing.ts'
import type { MinecraftCampControl } from '../protocol/api.ts'
import {
  DAILY_REFLECTION_CONTEXT,
  DEFAULT_CAPABILITIES,
  DEFAULT_PERSONA,
  SINGING_CONTEXT,
  type ActivityInput,
  type ActivityRecord,
  type CapabilityRecord,
  type CapabilityStatus,
  type ContextKind,
  type DeviceRecord,
  type MinecraftBuildZone,
  type Persona,
  type PersonaRevision,
  type SessionBinding,
  type TaskRecord,
  type TaskStatus,
  type TtsAsset,
  type WorkbenchStats,
} from './model.ts'

const SCHEMA_VERSION = 44

type PersonaFields = Pick<Persona, 'name' | 'tagline' | 'description'>
type PersonaRow = PersonaFields & { version: number; updated_at: string; change_kind: PersonaRevision['change']; reason: string | null; restored_from: number | null }

function personaFromRow(row: PersonaRow): Persona {
  return { version: row.version, name: row.name, tagline: row.tagline, description: row.description, updatedAt: row.updated_at }
}
const TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  accepted: ['running', 'failed', 'cancelled'],
  running: ['accepted', 'succeeded', 'failed', 'cancelled'],
  succeeded: [],
  failed: [],
  cancelled: [],
}

export class TaskTransitionError extends Error {
  readonly code = 'invalid-task-transition'
}

export class CompanionStore {
  readonly memory: MemoryRepository
  readonly feed: FeedRepository
  readonly autonomy: AutonomyRepository
  readonly selfNotes: SelfNoteRepository
  readonly media: MediaRepository
  readonly gameLearning: GameLearningRepository
  readonly bilibili: BilibiliQueueRepository
  readonly bilibiliSubtitles: BilibiliSubtitleRepository
  readonly notices: DeviceNoticeRepository
  readonly minecraftHouses: MinecraftHouseRepository
  readonly minecraftHouseProjects: MinecraftHouseProjectRepository
  readonly minecraftPlaces: MinecraftPlaceRepository

  constructor(path: string, private readonly activityRetention = 10_000) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    try {
      chmodSync(path, 0o600)
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON')
      const version = Number(this.db.prepare('PRAGMA user_version').get()?.user_version ?? 0)
      if (version > SCHEMA_VERSION) throw new Error(`Companion database schema ${version} is newer than supported schema ${SCHEMA_VERSION}`)
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS state (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS activity (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id TEXT UNIQUE,
          session_id TEXT,
          task_id TEXT,
          source TEXT NOT NULL,
          kind TEXT NOT NULL,
          summary TEXT NOT NULL,
          status TEXT NOT NULL,
          data_json TEXT NOT NULL,
          occurred_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS task (
          id TEXT PRIMARY KEY,
          external_id TEXT UNIQUE,
          capability_id TEXT NOT NULL,
          title TEXT NOT NULL,
          status TEXT NOT NULL,
          error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS capability (
          id TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `)
      if (version < 2) this.transaction(() => {
        this.db.exec(`
          ALTER TABLE activity ADD COLUMN context_id TEXT;
          ALTER TABLE task ADD COLUMN context_id TEXT;
          ALTER TABLE task ADD COLUMN session_id TEXT;
          CREATE TABLE session_binding (
            context_id TEXT PRIMARY KEY,
            session_id TEXT UNIQUE NOT NULL,
            kind TEXT NOT NULL,
            label TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE TABLE memory (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            content TEXT NOT NULL,
            scope TEXT NOT NULL,
            context_id TEXT,
            status TEXT NOT NULL,
            importance REAL NOT NULL,
            confidence REAL NOT NULL,
            pinned INTEGER NOT NULL DEFAULT 0,
            recall_count INTEGER NOT NULL DEFAULT 0,
            source_refs TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            last_used_at TEXT NOT NULL,
            forget_reason TEXT
          );
          CREATE TABLE memory_revision (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            memory_id TEXT NOT NULL,
            revision INTEGER NOT NULL,
            snapshot TEXT NOT NULL,
            actor_session_id TEXT,
            reason TEXT NOT NULL,
            created_at TEXT NOT NULL,
            UNIQUE(memory_id, revision)
          );
          PRAGMA user_version=2;
        `)
        const legacy = this.readState<string | null>('sessionId')
        if (legacy) {
          const now = new Date().toISOString()
          this.db.prepare('INSERT INTO session_binding VALUES (?,?,?,?,?,?)').run('chat.main', legacy, 'chat', '主聊天', now, now)
          this.db.prepare('UPDATE activity SET context_id=? WHERE session_id=?').run('chat.main', legacy)
        }
      })
      if (version < 3) this.transaction(() => {
        this.db.exec(`
          CREATE TABLE device (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            secret_hash TEXT NOT NULL,
            created_at TEXT NOT NULL,
            last_seen_at TEXT,
            revoked_at TEXT
          );
          CREATE INDEX device_active ON device(revoked_at, last_seen_at);
          PRAGMA user_version=3;
        `)
      })
      if (version < 4) this.transaction(() => {
        this.db.exec(`
          CREATE TABLE post (
            id TEXT PRIMARY KEY,
            parent_id TEXT REFERENCES post(id),
            author_kind TEXT NOT NULL CHECK(author_kind IN ('companion','user')),
            body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 4000),
            context_id TEXT,
            source_session_id TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            deleted_at TEXT
          );
          CREATE INDEX post_timeline ON post(parent_id, created_at DESC, id DESC);
          CREATE INDEX post_context ON post(context_id, created_at DESC);
          PRAGMA user_version=4;
        `)
      })
      if (version < 5) this.transaction(() => {
        this.db.exec(`
          CREATE TABLE tts_asset (
            id TEXT PRIMARY KEY,
            task_id TEXT UNIQUE NOT NULL REFERENCES task(id),
            context_id TEXT NOT NULL,
            source_message_id TEXT NOT NULL,
            voice TEXT NOT NULL,
            text_hash TEXT NOT NULL,
            file_path TEXT NOT NULL,
            mime_type TEXT NOT NULL,
            bytes INTEGER NOT NULL,
            duration_ms INTEGER NOT NULL,
            created_at TEXT NOT NULL
          );
          CREATE INDEX tts_asset_message ON tts_asset(context_id, source_message_id, voice);
          PRAGMA user_version=5;
        `)
      })
      if (version < 6) this.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS autonomous_job (
            task_id TEXT PRIMARY KEY REFERENCES task(id),
            kind TEXT NOT NULL,
            context_id TEXT NOT NULL,
            dedupe_key TEXT UNIQUE NOT NULL,
            run_after INTEGER NOT NULL,
            payload_json TEXT NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            max_attempts INTEGER NOT NULL DEFAULT 3,
            lease_until INTEGER,
            last_error TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS autonomous_job_due ON autonomous_job(kind, run_after);
          CREATE INDEX IF NOT EXISTS autonomous_job_context ON autonomous_job(context_id, kind, run_after);
          PRAGMA user_version=6;
        `)
      })
      if (version < 7) this.transaction(() => {
        this.db.exec(`
          CREATE TABLE self_note (
            id TEXT PRIMARY KEY,
            content TEXT NOT NULL CHECK(length(content) BETWEEN 1 AND 500),
            basis TEXT NOT NULL CHECK(basis IN ('observation','user-feedback','inference')),
            status TEXT NOT NULL CHECK(status IN ('active','archived')),
            confidence REAL NOT NULL CHECK(confidence BETWEEN 0 AND 1),
            evidence_json TEXT NOT NULL,
            counter_evidence_json TEXT NOT NULL,
            source_refs_json TEXT NOT NULL,
            created_by TEXT NOT NULL CHECK(created_by IN ('companion','owner')),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            archived_at TEXT
          );
          CREATE INDEX self_note_status ON self_note(status, updated_at DESC);
          CREATE TABLE self_note_revision (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            note_id TEXT NOT NULL REFERENCES self_note(id),
            revision INTEGER NOT NULL,
            snapshot TEXT NOT NULL,
            actor_session_id TEXT,
            reason TEXT NOT NULL,
            created_at TEXT NOT NULL,
            UNIQUE(note_id, revision)
          );
          CREATE INDEX self_note_revision_id ON self_note_revision(note_id, revision DESC);
          PRAGMA user_version=7;
        `)
      })
      if (version < 8) this.transaction(() => {
        this.db.exec(`
          CREATE TABLE media_asset (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            path TEXT UNIQUE NOT NULL,
            hash TEXT,
            mime_type TEXT NOT NULL,
            bytes INTEGER NOT NULL CHECK(bytes >= 0),
            source TEXT NOT NULL,
            source_ref TEXT,
            retention TEXT NOT NULL CHECK(retention IN ('cache','keep')),
            created_at TEXT NOT NULL,
            last_used_at TEXT NOT NULL,
            last_verified_at TEXT NOT NULL,
            missing_at TEXT
          );
          CREATE INDEX media_asset_kind ON media_asset(kind, retention, last_used_at DESC);
          CREATE INDEX media_asset_hash ON media_asset(hash, retention);
          PRAGMA user_version=8;
        `)
      })
      if (version < 9) this.transaction(() => {
        this.db.exec(`
          CREATE TABLE game_lesson (
            signature TEXT PRIMARY KEY,
            action TEXT NOT NULL,
            error_code TEXT NOT NULL,
            target_key TEXT NOT NULL,
            target_json TEXT,
            lesson TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('learning','resolved','disabled')),
            occurrences INTEGER NOT NULL CHECK(occurrences >= 1),
            source_refs_json TEXT NOT NULL,
            first_seen_at TEXT NOT NULL,
            last_seen_at TEXT NOT NULL,
            resolved_at TEXT
          );
          CREATE INDEX game_lesson_action ON game_lesson(action,status,last_seen_at DESC);
          PRAGMA user_version=9;
        `)
      })
      if (version < 10) this.transaction(() => {
        this.db.exec(`
          CREATE TABLE minecraft_build_zone (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            dimension TEXT NOT NULL,
            x INTEGER NOT NULL,
            y INTEGER NOT NULL,
            z INTEGER NOT NULL,
            radius INTEGER NOT NULL CHECK(radius BETWEEN 2 AND 8),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            revoked_at TEXT
          );
          CREATE INDEX minecraft_build_zone_active ON minecraft_build_zone(revoked_at, dimension, updated_at DESC);
          PRAGMA user_version=10;
        `)
      })
      if (version < 11) this.transaction(() => {
        this.db.exec(`
          ALTER TABLE media_asset ADD COLUMN deleted_at TEXT;
          CREATE INDEX media_asset_deleted ON media_asset(deleted_at, last_used_at);
          PRAGMA user_version=11;
        `)
      })
      if (version < 12) this.transaction(() => {
        this.db.exec(`
          ALTER TABLE post ADD COLUMN media_id TEXT REFERENCES media_asset(id);
          CREATE INDEX post_media ON post(media_id);
          PRAGMA user_version=12;
        `)
      })
      if (version < 13) this.transaction(() => {
        this.db.exec(`
          CREATE TABLE post_next (
            id TEXT PRIMARY KEY,
            parent_id TEXT REFERENCES post_next(id),
            author_kind TEXT NOT NULL CHECK(author_kind IN ('companion','user')),
            body TEXT NOT NULL CHECK(length(body) <= 4000 AND (length(body) > 0 OR media_id IS NOT NULL)),
            context_id TEXT,
            source_session_id TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            deleted_at TEXT,
            media_id TEXT REFERENCES media_asset(id)
          );
          INSERT INTO post_next (id,parent_id,author_kind,body,context_id,source_session_id,created_at,updated_at,deleted_at,media_id)
            SELECT id,parent_id,author_kind,body,context_id,source_session_id,created_at,updated_at,deleted_at,media_id FROM post;
          DROP TABLE post;
          ALTER TABLE post_next RENAME TO post;
          CREATE INDEX post_timeline ON post(parent_id, created_at DESC, id DESC);
          CREATE INDEX post_context ON post(context_id, created_at DESC);
          CREATE INDEX post_media ON post(media_id);
          PRAGMA user_version=13;
        `)
      })
      if (version < 14) this.transaction(() => {
        this.db.exec(`
          ALTER TABLE post ADD COLUMN source_task_id TEXT REFERENCES task(id);
          CREATE UNIQUE INDEX post_source_task ON post(source_task_id) WHERE source_task_id IS NOT NULL;
          PRAGMA user_version=14;
        `)
      })
      if (version < 15) this.transaction(() => {
        this.db.exec(`
          CREATE TABLE bilibili_candidate (
            id TEXT PRIMARY KEY,
            bvid TEXT NOT NULL,
            part INTEGER NOT NULL CHECK(part BETWEEN 1 AND 1000),
            label TEXT,
            status TEXT NOT NULL CHECK(status IN ('queued','reading','read','skipped','failed','cancelled')),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            receipt_json TEXT,
            error TEXT
          );
          CREATE UNIQUE INDEX bilibili_candidate_active ON bilibili_candidate(bvid,part) WHERE status IN ('queued','reading');
          CREATE INDEX bilibili_candidate_recent ON bilibili_candidate(status,updated_at);
          PRAGMA user_version=15;
        `)
      })
      // Older schedulers must refuse a database that can contain reflection jobs.
      if (version < 16) this.db.exec('PRAGMA user_version=16')
      // Older maintenance code would incorrectly treat archived rows as active.
      if (version < 17) this.transaction(() => {
        this.db.exec(`
          ALTER TABLE memory ADD COLUMN reinforcement_count INTEGER NOT NULL DEFAULT 0 CHECK(reinforcement_count >= 0);
          ALTER TABLE memory ADD COLUMN last_reinforced_at TEXT;
          ALTER TABLE memory ADD COLUMN archived_from TEXT CHECK(archived_from IN ('active','candidate'));
          ALTER TABLE memory ADD COLUMN archive_reason TEXT;
          PRAGMA user_version=17;
        `)
      })
      // A revoked collection keeps its identity for historical browsing receipts.
      if (version < 18) this.transaction(() => {
        this.db.exec(`
          CREATE TABLE bilibili_source (
            id TEXT PRIMARY KEY,
            mid TEXT NOT NULL,
            season_id TEXT NOT NULL,
            label TEXT,
            status TEXT NOT NULL CHECK(status IN ('waiting','added','unchanged','unavailable')),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            revoked_at TEXT,
            last_checked_at INTEGER,
            claim_at INTEGER,
            last_added INTEGER CHECK(last_added BETWEEN 0 AND 3),
            error TEXT
          );
          CREATE UNIQUE INDEX bilibili_source_active ON bilibili_source(mid,season_id) WHERE revoked_at IS NULL;
          ALTER TABLE bilibili_candidate ADD COLUMN source_id TEXT REFERENCES bilibili_source(id);
          ALTER TABLE bilibili_candidate ADD COLUMN source_title TEXT;
          CREATE INDEX bilibili_candidate_source ON bilibili_candidate(source_id,status) WHERE source_id IS NOT NULL;
          CREATE INDEX bilibili_candidate_history ON bilibili_candidate(bvid,part);
          PRAGMA user_version=18;
        `)
      })
      // Older schedulers must not process reflection jobs linked to revocable subtitles.
      if (version < 19) this.transaction(() => {
        this.db.exec(`
          CREATE TABLE bilibili_subtitle_attachment (
            bvid TEXT NOT NULL,
            part INTEGER NOT NULL CHECK(part BETWEEN 1 AND 1000),
            cid INTEGER NOT NULL CHECK(cid > 0),
            format TEXT NOT NULL CHECK(format IN ('srt','vtt')),
            sha256 TEXT NOT NULL CHECK(length(sha256)=64),
            cue_count INTEGER NOT NULL CHECK(cue_count BETWEEN 1 AND 6000),
            excerpt_cue_count INTEGER NOT NULL CHECK(excerpt_cue_count BETWEEN 1 AND min(cue_count,12)),
            updated_at TEXT NOT NULL,
            excerpt_json TEXT NOT NULL,
            PRIMARY KEY (bvid,part)
          );
          PRAGMA user_version=19;
        `)
      })
      if (version < 20) this.transaction(() => {
        this.db.exec(`
          CREATE TABLE song_vocal_envelope (
            asset_id TEXT PRIMARY KEY REFERENCES media_asset(id) ON DELETE CASCADE,
            audio_hash TEXT NOT NULL CHECK(length(audio_hash)=64),
            samples BLOB NOT NULL CHECK(typeof(samples)='blob' AND length(samples) BETWEEN 1 AND ${MAX_SONG_VOCAL_SAMPLES})
          );
          PRAGMA user_version=20;
        `)
      })
      if (version < 21) this.transaction(() => {
        this.db.exec(`
          ALTER TABLE self_note ADD COLUMN authorship_json TEXT NOT NULL DEFAULT '{}'
            CHECK(json_valid(authorship_json) AND json_type(authorship_json)='object');
          PRAGMA user_version=21;
        `)
      })
      // Older schedulers would treat a Bilibili share as a general world event.
      if (version < 22) this.db.exec('PRAGMA user_version=22')
      if (version < 23) this.transaction(() => {
        this.db.exec(`
          CREATE TABLE device_notice (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            kind TEXT NOT NULL,
            dedupe_key TEXT NOT NULL UNIQUE,
            occurred_at TEXT NOT NULL,
            post_id TEXT,
            reply_id TEXT,
            task_id TEXT,
            CHECK (
              (kind='chat-reply' AND post_id IS NULL AND reply_id IS NULL AND task_id IS NULL) OR
              (kind='feed-post' AND post_id IS NOT NULL AND reply_id IS NULL AND task_id IS NULL) OR
              (kind='feed-reply' AND post_id IS NOT NULL AND reply_id IS NOT NULL AND task_id IS NULL) OR
              (kind IN ('song-ready','song-failed','camp-completed','camp-returned')
                AND post_id IS NULL AND reply_id IS NULL AND task_id IS NOT NULL)
            )
          );
          CREATE TABLE device_notice_cursor (
            device_id TEXT PRIMARY KEY REFERENCES device(id) ON DELETE CASCADE,
            baseline_id INTEGER NOT NULL CHECK(baseline_id>=0),
            read_through_id INTEGER NOT NULL CHECK(read_through_id>=baseline_id)
          );
          CREATE TABLE device_notice_read (
            device_id TEXT NOT NULL REFERENCES device(id) ON DELETE CASCADE,
            notice_id INTEGER NOT NULL REFERENCES device_notice(id) ON DELETE CASCADE,
            PRIMARY KEY (device_id,notice_id)
          );
          CREATE INDEX device_notice_read_notice ON device_notice_read(notice_id);
          PRAGMA user_version=23;
        `)
      })
      if (version < 24) this.transaction(() => {
        this.db.exec(`
          ALTER TABLE post ADD COLUMN song_task_id TEXT REFERENCES task(id)
            CHECK(song_task_id IS NULL OR (author_kind='companion' AND parent_id IS NULL
              AND context_id IS '${SINGING_CONTEXT}' AND source_session_id IS NOT NULL
              AND media_id IS NULL AND source_task_id IS NULL AND length(trim(body)) BETWEEN 1 AND 280));
          CREATE UNIQUE INDEX post_song_task ON post(song_task_id) WHERE song_task_id IS NOT NULL;
          CREATE INDEX task_completed_song_title ON task(session_id,title)
            WHERE context_id='${SINGING_CONTEXT}' AND capability_id='media.singing' AND status='succeeded';
          PRAGMA user_version=24;
        `)
      })
      // Older hosts cannot safely dispatch the new daily.choice job kind.
      if (version < 25) this.db.exec('PRAGMA user_version=25')
      // Older hosts cannot safely dispatch the new daily.reflect job kind.
      if (version < 26) this.db.exec('PRAGMA user_version=26')
      // Older hosts cannot recover an interrupted Minecraft visit.
      if (version < 27) this.db.exec('PRAGMA user_version=27')
      // Older hosts cannot validate a short-visit supply receipt or recover its task.
      if (version < 28) this.db.exec('PRAGMA user_version=28')
      // Older hosts cannot validate a short-visit build receipt or recover its task.
      if (version < 29) this.db.exec('PRAGMA user_version=29')
      // Older hosts cannot preserve the camp project's visit order or validate its revisit.
      if (version < 30) this.db.exec('PRAGMA user_version=30')
      // Older hosts cannot recover a patrol or verify its ordered segment receipts.
      if (version < 31) this.db.exec('PRAGMA user_version=31')
      // Older schedulers cannot interpret a gathering grant.
      if (version < 32) this.db.exec('PRAGMA user_version=32')
      // Older hosts cannot validate or schedule gathering as part of a camp project.
      if (version < 33) this.db.exec('PRAGMA user_version=33')
      if (version < 34) this.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS minecraft_house (
            id TEXT PRIMARY KEY,
            source_session_id TEXT NOT NULL,
            source_message_id TEXT NOT NULL,
            zone_id TEXT REFERENCES minecraft_build_zone(id),
            payload_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('draft','running','built','interrupted')),
            attempt_task_id TEXT REFERENCES task(id),
            receipt_json TEXT,
            UNIQUE (source_session_id,source_message_id)
          );
          PRAGMA user_version=34;
        `)
      })
      // Older schedulers do not understand the new Minecraft milestone reflection and share sources.
      if (version < 35) this.db.exec('PRAGMA user_version=35')
      // Older hosts do not preserve the bounded receipt and the authored reason for a revised self note.
      if (version < 36) this.db.exec('PRAGMA user_version=36')
      if (version < 37) this.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS minecraft_house_revision (
            house_id TEXT NOT NULL REFERENCES minecraft_house(id),
            revision INTEGER NOT NULL CHECK (revision >= 0),
            blocks TEXT NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY (house_id,revision)
          );
          PRAGMA user_version=37;
        `)
      })
      // Older schedulers do not understand the managed Minecraft recovery job kind.
      if (version < 38) this.db.exec('PRAGMA user_version=38')
      if (version < 39) this.db.exec('PRAGMA user_version=39')
      if (version < 40) this.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS minecraft_house_recovery_cell (
            source_task_id TEXT NOT NULL REFERENCES task(id),
            cell_index INTEGER NOT NULL CHECK (cell_index BETWEEN 0 AND 124),
            task_id TEXT NOT NULL UNIQUE REFERENCES task(id),
            material TEXT NOT NULL CHECK (material IN ('oak_planks','spruce_planks','cobblestone','glass')),
            mode TEXT NOT NULL CHECK (mode IN ('single','continuous')),
            outcome TEXT NOT NULL CHECK (outcome IN ('started','placed','blocked','already-present','unconfirmed')),
            settled_at TEXT,
            PRIMARY KEY (source_task_id,cell_index),
            CHECK ((outcome='started')=(settled_at IS NULL))
          );
          PRAGMA user_version=40;
        `)
      })
      // Older schedulers cannot resume a daily decision that uses a native initiative proposal.
      if (version < 41) this.db.exec('PRAGMA user_version=41')
      if (version < 42) this.transaction(() => {
        if (Number(this.db.prepare('PRAGMA user_version').get()?.user_version) >= 42) return
        const prior = this.readState<Omit<Persona, 'version'>>('persona')
        const first = prior ?? DEFAULT_PERSONA
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS persona_revision (
            version INTEGER PRIMARY KEY CHECK(version > 0),
            name TEXT NOT NULL,
            tagline TEXT NOT NULL,
            description TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            change_kind TEXT NOT NULL CHECK(change_kind IN ('initial', 'imported', 'edit', 'restore')),
            reason TEXT,
            restored_from INTEGER REFERENCES persona_revision(version),
            CHECK ((change_kind='restore') = (restored_from IS NOT NULL))
          );
        `)
        this.db.prepare('INSERT OR IGNORE INTO persona_revision VALUES (1,?,?,?,?,?,NULL,NULL)')
          .run(first.name, first.tagline, first.description, prior?.updatedAt ?? new Date().toISOString(), prior ? 'imported' : 'initial')
        this.db.exec('PRAGMA user_version=42')
      })
      if (version < 43) this.transaction(() => {
        if (Number(this.db.prepare('PRAGMA user_version').get()?.user_version) >= 43) return
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS minecraft_house_project (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            zone_id TEXT NOT NULL REFERENCES minecraft_build_zone(id),
            created_at TEXT NOT NULL,
            verification_json TEXT,
            verified_once INTEGER NOT NULL DEFAULT 0 CHECK(verified_once IN (0,1))
          );
          CREATE TABLE IF NOT EXISTS minecraft_house_project_section (
            project_id TEXT NOT NULL REFERENCES minecraft_house_project(id),
            section_index INTEGER NOT NULL CHECK(section_index BETWEEN 0 AND 5),
            blueprint_json TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','built','interrupted')),
            task_id TEXT REFERENCES task(id),
            receipt_json TEXT,
            reason TEXT,
            PRIMARY KEY(project_id,section_index),
            CHECK ((status='built')=(receipt_json IS NOT NULL)),
            CHECK ((status='pending')=(task_id IS NULL)),
            CHECK ((status='interrupted')=(reason IS NOT NULL))
          );
          PRAGMA user_version=43;
        `)
      })
      if (version < 44) this.transaction(() => {
        if (Number(this.db.prepare('PRAGMA user_version').get()?.user_version) >= 44) return
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS minecraft_place (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL UNIQUE REFERENCES minecraft_house_project(id),
            name_key TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            memory_id TEXT NOT NULL REFERENCES memory(id),
            dimension TEXT NOT NULL,
            x INTEGER NOT NULL,
            y INTEGER NOT NULL,
            z INTEGER NOT NULL,
            verified_at TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          PRAGMA user_version=44;
        `)
      })
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS activity_time ON activity(id DESC);
        CREATE INDEX IF NOT EXISTS activity_session ON activity(session_id, id DESC);
        CREATE INDEX IF NOT EXISTS activity_context ON activity(context_id, id DESC);
        CREATE INDEX IF NOT EXISTS task_status ON task(status, updated_at DESC);
        CREATE INDEX IF NOT EXISTS memory_status ON memory(status, pinned, updated_at DESC);
        CREATE INDEX IF NOT EXISTS memory_context ON memory(context_id, status, updated_at DESC);
        CREATE INDEX IF NOT EXISTS memory_revision_id ON memory_revision(memory_id, revision DESC);
      `)
      const now = new Date().toISOString()
      const seed = this.db.prepare('INSERT OR IGNORE INTO capability VALUES (?,?,?)')
      for (const capability of DEFAULT_CAPABILITIES) seed.run(capability.id, JSON.stringify({ ...capability, updatedAt: now }), now)
      this.memory = new MemoryRepository(this.db, input => this.recordActivity(input), operation => this.transaction(operation))
      this.minecraftHouses = new MinecraftHouseRepository(this.db, operation => this.transaction(operation))
      this.minecraftHouseProjects = new MinecraftHouseProjectRepository(this.db, operation => this.transaction(operation))
      this.minecraftPlaces = new MinecraftPlaceRepository(this.db)
      this.media = new MediaRepository(this.db)
      this.gameLearning = new GameLearningRepository(this.db, input => this.recordActivity(input), operation => this.transaction(operation))
      this.bilibili = new BilibiliQueueRepository(this.db, operation => this.transaction(operation))
      this.feed = new FeedRepository(this.db, this.media, this.bilibili, operation => this.transaction(operation))
      this.bilibiliSubtitles = new BilibiliSubtitleRepository(this.db, operation => this.transaction(operation))
      this.autonomy = new AutonomyRepository(this.db, {
        createTask: (input, beforeActivity) => this.createTask(input, beforeActivity),
        taskFromRow: row => this.taskFromRow(row),
        transaction: operation => this.transaction(operation),
      })
      this.selfNotes = new SelfNoteRepository(this.db, input => this.recordActivity(input), operation => this.transaction(operation),
        id => this.autonomy.get(id), id => this.taskById(id), this)
      this.notices = new DeviceNoticeRepository(this.db, {
        transaction: operation => this.transaction(operation),
        findJob: id => this.autonomy.get(id),
        findTask: id => this.taskById(id),
      })
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  private readonly db: DatabaseSync

  private readState<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM state WHERE key=?').get(key)
    return row ? JSON.parse(String(row.value)) as T : undefined
  }

  private writeState(key: string, value: unknown): void {
    this.db.prepare('INSERT INTO state VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value))
  }

  minecraftCampControl(): MinecraftCampControl {
    return this.readState<MinecraftCampControl>('minecraft.camp-control') ?? { pairedPauseEnabled: false }
  }

  saveMinecraftCampControl(control: MinecraftCampControl): void {
    this.writeState('minecraft.camp-control', control)
  }

  persona(): Persona {
    return personaFromRow(this.db.prepare('SELECT * FROM persona_revision ORDER BY version DESC LIMIT 1').get() as PersonaRow)
  }

  personaHistory(before?: number): { revisions: PersonaRevision[]; nextBefore?: number } {
    const rows = this.db.prepare('SELECT * FROM persona_revision WHERE version < ? ORDER BY version DESC LIMIT 11')
      .all(before ?? Number.MAX_SAFE_INTEGER) as PersonaRow[]
    const revisions = rows.slice(0, 10).map(row => ({
      ...personaFromRow(row), change: row.change_kind,
      ...(row.reason !== null && { reason: row.reason }),
      ...(row.restored_from !== null && { restoredFrom: row.restored_from }),
    }))
    return { revisions, ...(rows.length > 10 && { nextBefore: revisions[9]!.version }) }
  }

  savePersona(input: PersonaFields & { expectedVersion?: number; reason?: string }): Persona {
    return this.transaction(() => this.writePersona(input, input.expectedVersion, input.reason))
  }

  restorePersona(version: number, expectedVersion: number, reason?: string): Persona {
    return this.transaction(() => {
      const source = this.db.prepare('SELECT * FROM persona_revision WHERE version=?').get(version) as PersonaRow | undefined
      if (!source) throw new Error('Persona version not found')
      return this.writePersona(source, expectedVersion, reason, version)
    })
  }

  private writePersona(input: PersonaFields, expectedVersion?: number, reason?: string, restoredFrom?: number): Persona {
    const current = this.persona()
    if (expectedVersion !== undefined && current.version !== expectedVersion) throw new Error('persona-version-conflict')
    const { name, tagline, description } = input
    if (current.name === name && current.tagline === tagline && current.description === description) return current
    const persona = { version: current.version + 1, name, tagline, description, updatedAt: new Date().toISOString() }
    this.db.prepare('INSERT INTO persona_revision VALUES (?,?,?,?,?,?,?,?)')
      .run(persona.version, name, tagline, description, persona.updatedAt, restoredFrom === undefined ? 'edit' : 'restore', reason ?? null, restoredFrom ?? null)
    this.recordActivity({ source: 'core.persona', kind: restoredFrom === undefined ? 'persona.updated' : 'persona.restored',
      summary: restoredFrom === undefined ? '角色档案已更新' : '已恢复旧版角色档案', status: 'success',
      data: { version: persona.version, ...(restoredFrom !== undefined && { restoredFrom }) } })
    return persona
  }

  bindings(): SessionBinding[] {
    return this.db.prepare('SELECT * FROM session_binding ORDER BY created_at').all().map(row => {
      const value = row as { context_id: string; session_id: string; kind: ContextKind; label: string; created_at: string; updated_at: string }
      return {
        contextId: value.context_id,
        sessionId: value.session_id,
        kind: value.kind,
        label: value.label,
        createdAt: value.created_at,
        updatedAt: value.updated_at,
      }
    })
  }

  bindingBySession(sessionId: string): SessionBinding | undefined {
    return this.bindings().find(binding => binding.sessionId === sessionId)
  }

  bindingByContext(contextId: string): SessionBinding | undefined {
    return this.bindings().find(binding => binding.contextId === contextId)
  }

  binding(): string | null {
    return this.bindingByContext('chat.main')?.sessionId ?? null
  }

  bindContext(input: { contextId: string; sessionId: string; kind: ContextKind; label: string }): SessionBinding {
    const current = this.bindingByContext(input.contextId)
    const now = new Date().toISOString()
    const binding: SessionBinding = { ...input, createdAt: current?.createdAt ?? now, updatedAt: now }
    this.db.prepare(`INSERT INTO session_binding VALUES (?,?,?,?,?,?)
      ON CONFLICT(context_id) DO UPDATE SET session_id=excluded.session_id, kind=excluded.kind, label=excluded.label, updated_at=excluded.updated_at`)
      .run(binding.contextId, binding.sessionId, binding.kind, binding.label, binding.createdAt, binding.updatedAt)
    return binding
  }

  bind(sessionId: string | null): void {
    if (sessionId) this.bindContext({ contextId: 'chat.main', sessionId, kind: 'chat', label: '主聊天' })
    else this.unbindContext('chat.main')
  }

  unbindContext(contextId: string): boolean {
    return this.db.prepare('DELETE FROM session_binding WHERE context_id=?').run(contextId).changes > 0
  }

  createDevice(record: DeviceRecord): void {
    this.transaction(() => {
      this.db.prepare('INSERT INTO device VALUES (?,?,?,?,?,?)').run(
        record.id, record.name, record.secretHash, record.createdAt, record.lastSeenAt ?? null, record.revokedAt ?? null,
      )
      this.notices.registerDevice(record.id)
    })
  }

  deviceById(id: string): DeviceRecord | undefined {
    const row = this.db.prepare('SELECT * FROM device WHERE id=?').get(id)
    return row ? this.deviceFromRow(row) : undefined
  }

  devices(): DeviceRecord[] {
    return this.db.prepare('SELECT * FROM device ORDER BY created_at DESC').all().map(row => this.deviceFromRow(row))
  }

  private deviceFromRow(row: unknown): DeviceRecord {
    const value = row as { id: string; name: string; secret_hash: string; created_at: string; last_seen_at: string | null; revoked_at: string | null }
    return {
      id: value.id,
      name: value.name,
      secretHash: value.secret_hash,
      createdAt: value.created_at,
      lastSeenAt: value.last_seen_at ?? undefined,
      revokedAt: value.revoked_at ?? undefined,
    }
  }

  touchDevice(id: string, now: string): void {
    this.db.prepare('UPDATE device SET last_seen_at=? WHERE id=?').run(now, id)
  }

  revokeDevice(id: string, revokedAt: string): boolean {
    return this.db.prepare('UPDATE device SET revoked_at=? WHERE id=? AND revoked_at IS NULL').run(revokedAt, id).changes > 0
  }

  createBuildZone(input: Pick<MinecraftBuildZone, 'name' | 'dimension' | 'x' | 'y' | 'z' | 'radius'>): MinecraftBuildZone {
    const name = input.name.trim()
    if (!name || name.length > 80) throw new Error('Invalid build zone name')
    if (!/^[a-z0-9_:.-]{1,64}$/u.test(input.dimension)) throw new Error('Invalid build zone dimension')
    if (![input.x, input.y, input.z, input.radius].every(Number.isSafeInteger)) throw new Error('Invalid build zone coordinates')
    if (Math.abs(input.x) > 30_000_000 || Math.abs(input.z) > 30_000_000 || input.y < -2048 || input.y > 2032) throw new Error('Invalid build zone coordinates')
    if (input.radius < 2 || input.radius > 8) throw new Error('Build zone radius must be between 2 and 8')
    const now = new Date().toISOString()
    const zone: MinecraftBuildZone = { ...input, name, id: randomUUID(), createdAt: now, updatedAt: now }
    this.db.prepare(`INSERT INTO minecraft_build_zone
      (id,name,dimension,x,y,z,radius,created_at,updated_at,revoked_at)
      VALUES (?,?,?,?,?,?,?,?,?,NULL)`).run(zone.id, zone.name, zone.dimension, zone.x, zone.y, zone.z, zone.radius, now, now)
    this.recordActivity({ contextId: 'game.minecraft', source: 'game.build', kind: 'build-zone.created', summary: `主人授权建筑区域：${zone.name}`, data: { zoneId: zone.id, dimension: zone.dimension, x: zone.x, y: zone.y, z: zone.z, radius: zone.radius } })
    return zone
  }

  buildZones(): MinecraftBuildZone[] {
    return this.db.prepare('SELECT * FROM minecraft_build_zone WHERE revoked_at IS NULL ORDER BY updated_at DESC').all().map(row => this.buildZoneFromRow(row))
  }

  buildZoneById(id: string): MinecraftBuildZone | undefined {
    const row = this.db.prepare('SELECT * FROM minecraft_build_zone WHERE id=? AND revoked_at IS NULL').get(id)
    return row ? this.buildZoneFromRow(row) : undefined
  }

  revokeBuildZone(id: string): boolean {
    const revokedAt = new Date().toISOString()
    const zone = this.buildZoneById(id)
    const changed = this.db.prepare('UPDATE minecraft_build_zone SET revoked_at=?,updated_at=? WHERE id=? AND revoked_at IS NULL').run(revokedAt, revokedAt, id).changes > 0
    if (changed && zone) this.recordActivity({ contextId: 'game.minecraft', source: 'game.build', kind: 'build-zone.revoked', summary: `主人撤销建筑区域：${zone.name}`, status: 'warning', data: { zoneId: id } })
    return changed
  }

  private buildZoneFromRow(row: unknown): MinecraftBuildZone {
    const value = row as { id: string; name: string; dimension: string; x: number; y: number; z: number; radius: number; created_at: string; updated_at: string; revoked_at: string | null }
    return {
      id: value.id,
      name: value.name,
      dimension: value.dimension,
      x: Number(value.x),
      y: Number(value.y),
      z: Number(value.z),
      radius: Number(value.radius),
      createdAt: value.created_at,
      updatedAt: value.updated_at,
      revokedAt: value.revoked_at ?? undefined,
    }
  }

  transaction<T>(operation: () => T): T {
    if (this.db.isTransaction) {
      this.db.exec('SAVEPOINT companion_nested')
      try {
        const value = operation()
        this.db.exec('RELEASE companion_nested')
        return value
      } catch (error) {
        this.db.exec('ROLLBACK TO companion_nested; RELEASE companion_nested')
        throw error
      }
    }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const value = operation()
      this.db.exec('COMMIT')
      return value
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  recordActivity(input: ActivityInput): number {
    const eventId = input.eventId ?? randomUUID()
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO activity
        (event_id, context_id, session_id, task_id, source, kind, summary, status, data_json, occurred_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(
      eventId,
      input.contextId ?? null,
      input.sessionId ?? null,
      input.taskId ?? null,
      input.source,
      input.kind,
      input.summary,
      input.status ?? 'info',
      JSON.stringify(input.data ?? {}),
      input.occurredAt ?? new Date().toISOString(),
    )
    this.db.prepare('DELETE FROM activity WHERE id <= (SELECT COALESCE(MAX(id),0) - ? FROM activity)').run(this.activityRetention)
    if (result.changes) return Number(result.lastInsertRowid)
    const existing = this.db.prepare('SELECT id FROM activity WHERE event_id=?').get(eventId)
    return Number(existing?.id ?? 0)
  }

  private activityFromRow(row: unknown): ActivityRecord {
    const value = row as {
      id: number; event_id: string; context_id: string | null; session_id: string | null; task_id: string | null; source: string; kind: string
      summary: string; status: ActivityRecord['status']; data_json: string; occurred_at: string
    }
    return {
      id: Number(value.id),
      eventId: value.event_id,
      contextId: value.context_id ?? undefined,
      sessionId: value.session_id ?? undefined,
      taskId: value.task_id ?? undefined,
      source: value.source,
      kind: value.kind,
      summary: value.summary,
      status: value.status,
      data: JSON.parse(value.data_json) as Record<string, never>,
      occurredAt: value.occurred_at,
    }
  }

  activities(limit = 100): ActivityRecord[] {
    return this.db.prepare('SELECT * FROM activity ORDER BY id DESC LIMIT ?').all(limit).map(row => this.activityFromRow(row))
  }

  activityById(id: number): ActivityRecord | undefined {
    const row = this.db.prepare('SELECT * FROM activity WHERE id=?').get(id)
    return row ? this.activityFromRow(row) : undefined
  }

  activityByEventId(eventId: string): ActivityRecord | undefined {
    const row = this.db.prepare('SELECT * FROM activity WHERE event_id=?').get(eventId)
    return row ? this.activityFromRow(row) : undefined
  }

  selfNoteWasRecalled(contextId: string, sessionId: string, noteId: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM activity WHERE context_id=? AND session_id=? AND source='core.memory' AND kind='memory.recalled'
      AND EXISTS(SELECT 1 FROM json_each(activity.data_json, '$.selfNoteIds') WHERE value=?) LIMIT 1`).get(contextId, sessionId, noteId)
  }

  activityByTask(taskId: string, kind: string, contextId: string): ActivityRecord | undefined {
    const rows = this.db.prepare('SELECT * FROM activity WHERE context_id=? AND task_id=? AND kind=? LIMIT 2').all(contextId, taskId, kind)
    return rows.length === 1 ? this.activityFromRow(rows[0]) : undefined
  }

  latestHomeJournalRevision(since: string, now: string): string | undefined {
    const row = this.db.prepare(`SELECT a.occurred_at FROM activity a
      JOIN self_note n ON n.id=json_extract(a.data_json,'$.noteId') AND n.created_by='companion'
      WHERE a.context_id=? AND a.source='core.self-note' AND a.kind='self-note.created' AND a.status='success'
      AND length(trim(a.session_id))>0 AND a.occurred_at>? AND a.occurred_at<=? AND n.created_at<=a.occurred_at
      AND json_type(a.data_json,'$.journalRevision')='true'
      AND json_type(n.authorship_json,'$.revisionReason')='text' AND json_type(n.authorship_json,'$.experienceReceipt.fact')='text'
      AND json_extract(n.authorship_json,'$.experienceReceipt.at')<=n.created_at
      AND json_extract(n.authorship_json,'$.supersedes')=json_extract(a.data_json,'$.supersedes')
      AND json_extract(n.source_refs_json,'$[0].contextId')=a.context_id
      AND json_extract(n.source_refs_json,'$[0].sessionId')=a.session_id
      ORDER BY a.occurred_at DESC,a.id DESC LIMIT 1`).get(DAILY_REFLECTION_CONTEXT, since, now)
    return typeof row?.occurred_at === 'string' ? row.occurred_at : undefined
  }

  latestForegroundActivityAt(since: number): number | undefined {
    const row = this.db.prepare(`SELECT occurred_at FROM activity
      WHERE occurred_at BETWEEN ? AND ? AND session_id IS NOT NULL AND context_id IS NOT NULL
      AND context_id<>'memory.curator' AND context_id NOT GLOB 'autonomy.*' AND context_id NOT GLOB 'feed.reply.*'
      AND ((source='core.chat' AND kind='message.accepted') OR (source='core.session' AND kind GLOB 'turn.*'))
      ORDER BY occurred_at DESC LIMIT 1`).get(new Date(since).toISOString(), new Date().toISOString())
    const at = Date.parse(String(row?.occurred_at))
    return Number.isFinite(at) ? at : undefined
  }

  activitiesAfter(cursor: number, limit = 1000, contextId?: string): ActivityRecord[] {
    const rows = contextId
      ? this.db.prepare('SELECT * FROM activity WHERE id>? AND (context_id=? OR context_id IS NULL) ORDER BY id ASC LIMIT ?').all(cursor, contextId, limit)
      : this.db.prepare('SELECT * FROM activity WHERE id>? ORDER BY id ASC LIMIT ?').all(cursor, limit)
    return rows.map(row => this.activityFromRow(row))
  }

  latestActivityId(): number {
    return Number(this.db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM activity').get()?.id ?? 0)
  }

  taskById(id: string): TaskRecord | undefined {
    const row = this.db.prepare('SELECT * FROM task WHERE id=?').get(id)
    return row ? this.taskFromRow(row) : undefined
  }

  taskByExternalId(id: string): TaskRecord | undefined {
    const row = this.db.prepare('SELECT * FROM task WHERE external_id=?').get(id)
    return row ? this.taskFromRow(row) : undefined
  }

  latestTaskByExternalPrefix(prefix: string): TaskRecord | undefined {
    const row = this.db.prepare('SELECT * FROM task WHERE external_id >= ? AND external_id < ? ORDER BY rowid DESC LIMIT 1')
      .get(prefix, `${prefix}\uffff`)
    return row ? this.taskFromRow(row) : undefined
  }

  createTtsAsset(asset: TtsAsset): void {
    this.db.prepare(`INSERT INTO tts_asset
      (id, task_id, context_id, source_message_id, voice, text_hash, file_path, mime_type, bytes, duration_ms, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      asset.id, asset.taskId, asset.contextId, asset.sourceMessageId, asset.voice, asset.textHash,
      asset.filePath, asset.mimeType, asset.bytes, asset.durationMs, asset.createdAt,
    )
  }

  ttsAssetByTask(taskId: string): TtsAsset | undefined {
    const row = this.db.prepare('SELECT * FROM tts_asset WHERE task_id=?').get(taskId) as {
      id: string; task_id: string; context_id: string; source_message_id: string; voice: string; text_hash: string
      file_path: string; mime_type: 'audio/wav'; bytes: number; duration_ms: number; created_at: string
    } | undefined
    return row ? {
      id: row.id,
      taskId: row.task_id,
      contextId: row.context_id,
      sourceMessageId: row.source_message_id,
      voice: row.voice,
      textHash: row.text_hash,
      filePath: row.file_path,
      mimeType: row.mime_type,
      bytes: Number(row.bytes),
      durationMs: Number(row.duration_ms),
      createdAt: row.created_at,
    } : undefined
  }

  ttsAssets(): TtsAsset[] {
    return this.db.prepare('SELECT task_id FROM tts_asset ORDER BY created_at').all()
      .map(row => this.ttsAssetByTask(String((row as { task_id: string }).task_id))!)
  }

  createTask(input: Pick<TaskRecord, 'capabilityId' | 'title'> & { externalId?: string; contextId?: string; sessionId?: string }, beforeActivity?: (task: TaskRecord) => void): TaskRecord {
    if (input.externalId) {
      const existing = this.taskByExternalId(input.externalId)
      if (existing) return existing
    }
    const now = new Date().toISOString()
    const task: TaskRecord = {
      id: randomUUID(),
      externalId: input.externalId,
      contextId: input.contextId,
      sessionId: input.sessionId,
      capabilityId: input.capabilityId,
      title: input.title,
      status: 'accepted',
      createdAt: now,
      updatedAt: now,
    }
    this.transaction(() => {
      this.db.prepare('INSERT INTO task (id,external_id,context_id,session_id,capability_id,title,status,error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(
        task.id, task.externalId ?? null, task.contextId ?? null, task.sessionId ?? null,
        task.capabilityId, task.title, task.status, null, task.createdAt, task.updatedAt,
      )
      beforeActivity?.(task)
      this.recordActivity({ contextId: task.contextId, sessionId: task.sessionId, taskId: task.id, source: task.capabilityId, kind: 'task.accepted', summary: task.title })
    })
    return task
  }

  transitionTask(id: string, status: TaskStatus, error?: string, beforeActivity?: (task: TaskRecord) => void): TaskRecord {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM task WHERE id=?').get(id)
      if (!row) throw new Error('Task not found')
      const current = this.taskFromRow(row)
      if (current.status === status) return current
      if (!TASK_TRANSITIONS[current.status].includes(status)) {
        throw new TaskTransitionError(`Cannot transition task ${current.status} to ${status}`)
      }
      const next = { ...current, status, error, updatedAt: new Date().toISOString() }
      this.db.prepare('UPDATE task SET status=?, error=?, updated_at=? WHERE id=?').run(status, error ?? null, next.updatedAt, id)
      beforeActivity?.(next)
      this.recordActivity({
        contextId: current.contextId,
        sessionId: current.sessionId,
        taskId: id,
        source: current.capabilityId,
        kind: `task.${status}`,
        summary: current.title,
        status: status === 'failed' ? 'error' : status === 'cancelled' ? 'warning' : status === 'succeeded' ? 'success' : 'info',
        data: error ? { error } : {},
      })
      return next
    })
  }

  tasks(limit = 100, capabilityId?: string): TaskRecord[] {
    const rows = capabilityId === undefined
      ? this.db.prepare('SELECT * FROM task ORDER BY updated_at DESC, rowid DESC LIMIT ?').all(limit)
      : this.db.prepare('SELECT * FROM task WHERE capability_id=? ORDER BY updated_at DESC, rowid DESC LIMIT ?').all(capabilityId, limit)
    return rows.map(row => this.taskFromRow(row))
  }

  runningTasksByCapability(capabilityId: string): TaskRecord[] {
    return this.db.prepare("SELECT * FROM task WHERE capability_id=? AND status='running'").all(capabilityId).map(row => this.taskFromRow(row))
  }

  private taskFromRow(row: unknown): TaskRecord {
    const value = row as {
      id: string; external_id: string | null; context_id: string | null; session_id: string | null
      capability_id: string; title: string; status: TaskStatus; error: string | null; created_at: string; updated_at: string
    }
    return {
      id: value.id,
      externalId: value.external_id ?? undefined,
      contextId: value.context_id ?? undefined,
      sessionId: value.session_id ?? undefined,
      capabilityId: value.capability_id,
      title: value.title,
      status: value.status,
      error: value.error ?? undefined,
      createdAt: value.created_at,
      updatedAt: value.updated_at,
    }
  }

  capabilities(): CapabilityRecord[] {
    return this.db.prepare('SELECT value FROM capability ORDER BY rowid').all().map(row => JSON.parse(String(row.value)) as CapabilityRecord)
  }

  updateCapability(id: string, status: CapabilityStatus, detail: string): void {
    const updatedAt = new Date().toISOString()
    this.db.prepare('UPDATE capability SET value=?, updated_at=? WHERE id=?').run(JSON.stringify({
      ...this.capabilities().find(capability => capability.id === id),
      id,
      status,
      detail,
      updatedAt,
    }), updatedAt, id)
  }

  stats(): WorkbenchStats {
    const since = new Date(Date.now() - 86_400_000).toISOString()
    const counts = this.db.prepare(`
      SELECT COUNT(*) AS activities,
        SUM(CASE WHEN occurred_at >= ? THEN 1 ELSE 0 END) AS activities24h
      FROM activity
    `).get(since) as { activities: number; activities24h: number }
    const tasks = this.db.prepare(`
      SELECT SUM(CASE WHEN status IN ('accepted','running') THEN 1 ELSE 0 END) AS running,
        SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed
      FROM task
    `).get() as { running: number | null; failed: number | null }
    const usage = this.db.prepare(`
      WITH calls AS (
        SELECT COALESCE(CAST(json_extract(data_json,'$.inputTokens') AS INTEGER),0) AS uncached,
          COALESCE(CAST(json_extract(data_json,'$.outputTokens') AS INTEGER),0) AS output,
          COALESCE(CAST(json_extract(data_json,'$.cacheReadTokens') AS INTEGER),0) AS cache_read,
          COALESCE(CAST(json_extract(data_json,'$.cacheWriteTokens') AS INTEGER),0) AS cache_write,
          json_extract(data_json,'$.usageReported') AS reported,
          CAST(json_extract(data_json,'$.reasoningTokens') AS INTEGER) AS reasoning,
          context_id,
          json_extract(data_json,'$.totalTokens') AS reported_total,
          (context_id='memory.curator' OR context_id LIKE 'autonomy.%' OR context_id LIKE 'feed.reply.%') AS background,
          occurred_at>=? AS recent
        FROM activity WHERE source='core.session' AND kind='assistant.completed'
      ), classified AS (
        SELECT *, COALESCE(reported, reported_total IS NOT NULL OR uncached+output+cache_read+cache_write>0) AS measured FROM calls
      ), by_context AS (
        SELECT context_id, COUNT(*) FILTER (WHERE measured) AS measured,
          COUNT(*) FILTER (WHERE NOT measured) AS unmetered,
          COALESCE(SUM(uncached) FILTER (WHERE measured),0) AS uncached,
          COALESCE(SUM(cache_read) FILTER (WHERE measured),0) AS cache_read,
          COALESCE(SUM(cache_write) FILTER (WHERE measured),0) AS cache_write,
          COALESCE(SUM(output) FILTER (WHERE measured),0) AS output,
          SUM(reasoning) FILTER (WHERE measured) AS reasoning
        FROM classified WHERE recent AND context_id IS NOT NULL
        GROUP BY context_id ORDER BY uncached + cache_write + output DESC, unmetered DESC, context_id LIMIT 8
      )
      SELECT COALESCE(SUM(uncached),0) AS lifetime_input, COALESCE(SUM(output),0) AS lifetime_output,
        COUNT(*) FILTER (WHERE recent AND measured) AS measured, COUNT(*) FILTER (WHERE recent AND NOT measured) AS unmetered,
        COALESCE(SUM(uncached) FILTER (WHERE recent AND measured),0) AS uncached,
        COALESCE(SUM(cache_read) FILTER (WHERE recent AND measured),0) AS cache_read,
        COALESCE(SUM(cache_write) FILTER (WHERE recent AND measured),0) AS cache_write,
        COALESCE(SUM(output) FILTER (WHERE recent AND measured),0) AS output,
        COUNT(*) FILTER (WHERE recent AND measured AND background) AS background,
        COALESCE(SUM(uncached) FILTER (WHERE recent AND measured AND background),0) AS background_uncached,
        (SELECT json_group_array(json_object(
          'contextId', context_id, 'measuredCalls', measured, 'unmeteredCalls', unmetered,
          'uncachedInputTokens', uncached, 'cacheReadTokens', cache_read, 'cacheWriteTokens', cache_write,
          'outputTokens', output, 'reasoningTokens', reasoning
        )) FROM by_context) AS by_context
      FROM classified
    `).get(since)!
    return {
      activities: Number(counts.activities),
      activities24h: Number(counts.activities24h ?? 0),
      runningTasks: Number(tasks.running ?? 0),
      failedTasks: Number(tasks.failed ?? 0),
      inputTokens: Number(usage.lifetime_input),
      outputTokens: Number(usage.lifetime_output),
      usage24h: {
        measuredCalls: Number(usage.measured),
        unmeteredCalls: Number(usage.unmetered),
        uncachedInputTokens: Number(usage.uncached),
        cacheReadTokens: Number(usage.cache_read),
        cacheWriteTokens: Number(usage.cache_write),
        outputTokens: Number(usage.output),
        backgroundCalls: Number(usage.background),
        backgroundUncachedInputTokens: Number(usage.background_uncached),
        byContext: JSON.parse(String(usage.by_context)),
      },
    }
  }

  close(): void {
    this.db.close()
  }
}
