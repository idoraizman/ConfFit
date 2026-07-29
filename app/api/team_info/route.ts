import { NextResponse } from 'next/server'
import { TEAM } from '@/lib/team'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json(TEAM)
}
