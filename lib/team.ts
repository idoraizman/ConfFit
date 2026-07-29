/**
 * Team details served by GET /api/team_info.
 *
 * Values can be overridden per-environment without a redeploy of this file by
 * setting TEAM_BATCH_ORDER / TEAM_EMAIL_ITAY / TEAM_EMAIL_ROI in Vercel.
 */
export const TEAM = {
  group_batch_order_number: process.env.TEAM_BATCH_ORDER?.trim() || '3_4',
  team_name: 'ConfFit',
  students: [
    { name: 'Itay Krausz', email: process.env.TEAM_EMAIL_ITAY?.trim() || 'itay.krausz@campus.technion.ac.il' },
    { name: 'Ido Raizman', email: process.env.TEAM_EMAIL_IDO?.trim() || 'ido.raizman@campus.technion.ac.il' },
    { name: 'Roi Teichman', email: process.env.TEAM_EMAIL_ROI?.trim() || 'roi.teichman@campus.technion.ac.il' },
  ],
} as const
