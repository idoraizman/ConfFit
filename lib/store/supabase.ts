import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { config } from '../config'
import type { ConferenceProfile, PendingApproval, RunUsage } from '../types'
import type { Store } from './index'

/**
 * Supabase-backed store. Schema lives in docs/supabase.sql.
 *
 * Every method degrades to the in-memory store on error: a database hiccup
 * should slow ConfFit down (cache miss), not fail the user's request.
 */
export function createSupabaseStore(fallback: Store): Store {
  let client: SupabaseClient | null = null
  const db = () => (client ??= createClient(config.supabase.url, config.supabase.key, {
    auth: { persistSession: false },
  }))

  const warn = (op: string, e: unknown) => {
    console.warn(`[supabase] ${op} failed, falling back to memory:`, (e as Error)?.message ?? e)
  }

  return {
    backend: 'supabase',

    async getProfile(venueId) {
      try {
        const { data, error } = await db()
          .from('conference_profiles')
          .select('profile')
          .eq('venue_id', venueId)
          .maybeSingle()
        if (error) throw error
        return (data?.profile as ConferenceProfile | undefined) ?? null
      } catch (e) {
        warn('getProfile', e)
        return fallback.getProfile(venueId)
      }
    },

    async putProfile(profile) {
      try {
        const { error } = await db()
          .from('conference_profiles')
          .upsert(
            {
              venue_id: profile.venue_id,
              venue: profile.venue,
              profile,
              updated_at: new Date().toISOString(),
            },
            { onConflict: 'venue_id' },
          )
        if (error) throw error
      } catch (e) {
        warn('putProfile', e)
      }
      // Mirror into memory so the current instance stays warm either way.
      await fallback.putProfile(profile)
    },

    async findPending(sessionId, venueId) {
      try {
        let q = db()
          .from('pending_approvals')
          .select('payload')
          .order('created_at', { ascending: false })
          .limit(1)
        q = venueId ? q.eq('venue_id', venueId) : q.eq('session_id', sessionId)
        const { data, error } = await q
        if (error) throw error
        const row = data?.[0]?.payload as PendingApproval | undefined
        if (row) return row
      } catch (e) {
        warn('findPending', e)
      }
      return fallback.findPending(sessionId, venueId)
    },

    async putPending(pending) {
      try {
        const { error } = await db()
          .from('pending_approvals')
          .upsert(
            {
              session_id: pending.session_id,
              venue_id: pending.venue_id,
              payload: pending,
              created_at: pending.created_at,
            },
            { onConflict: 'session_id,venue_id' },
          )
        if (error) throw error
      } catch (e) {
        warn('putPending', e)
      }
      await fallback.putPending(pending)
    },

    async clearPending(sessionId, venueId) {
      try {
        const { error } = await db()
          .from('pending_approvals')
          .delete()
          .eq('session_id', sessionId)
          .eq('venue_id', venueId)
        if (error) throw error
      } catch (e) {
        warn('clearPending', e)
      }
      await fallback.clearPending(sessionId, venueId)
    },

    async recordRun(run: { session_id: string; venue_id: string | null; task: string; usage: RunUsage }) {
      try {
        await db().from('runs').insert({
          session_id: run.session_id,
          venue_id: run.venue_id,
          task: run.task,
          usage: run.usage,
        })
      } catch (e) {
        warn('recordRun', e)
      }
    },
  }
}
