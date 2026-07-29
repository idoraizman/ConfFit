import { config } from '../config'
import type { ConferenceProfile, PendingApproval, RunUsage } from '../types'
import { createSupabaseStore } from './supabase'

/**
 * Persistence for the conference-profile cache, the human-in-the-loop pending
 * approvals and run history.
 *
 * Supabase is the primary database. When it is not configured (local dev, or a
 * transient outage) we fall back to an in-process store so the agent still runs
 * — degraded to per-instance memory rather than broken.
 */
export interface Store {
  readonly backend: 'supabase' | 'memory'
  getProfile(venueId: string): Promise<ConferenceProfile | null>
  putProfile(profile: ConferenceProfile): Promise<void>
  /** Looks up by session first, then by venue, so a bare "yes" still resolves. */
  findPending(sessionId: string, venueId: string | null): Promise<PendingApproval | null>
  putPending(pending: PendingApproval): Promise<void>
  clearPending(sessionId: string, venueId: string): Promise<void>
  recordRun(run: {
    session_id: string
    venue_id: string | null
    task: string
    usage: RunUsage
  }): Promise<void>
}

const profiles = new Map<string, ConferenceProfile>()
const pendings = new Map<string, PendingApproval>()

function key(sessionId: string, venueId: string) {
  return `${sessionId}::${venueId}`
}

export const memoryStore: Store = {
  backend: 'memory',
  async getProfile(venueId) {
    return profiles.get(venueId) ?? null
  },
  async putProfile(profile) {
    profiles.set(profile.venue_id, profile)
  },
  async findPending(sessionId, venueId) {
    if (venueId) {
      const exact = pendings.get(key(sessionId, venueId))
      if (exact) return exact
      for (const p of pendings.values()) if (p.venue_id === venueId) return p
    }
    // Bare approval with no venue named: the most recent pending for the session.
    const mine = [...pendings.values()]
      .filter((p) => p.session_id === sessionId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
    return mine[0] ?? null
  },
  async putPending(pending) {
    pendings.set(key(pending.session_id, pending.venue_id), pending)
  },
  async clearPending(sessionId, venueId) {
    pendings.delete(key(sessionId, venueId))
  },
  async recordRun() {
    /* run history is a Supabase-only nicety */
  },
}

let cached: Store | null = null

export function getStore(): Store {
  if (cached) return cached
  cached = config.supabase.enabled ? createSupabaseStore(memoryStore) : memoryStore
  return cached
}
