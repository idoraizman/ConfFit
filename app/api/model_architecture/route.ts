import { ARCHITECTURE_PNG_BASE64 } from '@/lib/architecture-png'

export const runtime = 'nodejs'

/**
 * The PNG is bundled as a base64 module rather than read from public/ at
 * request time, so the endpoint cannot break on a change to how the serverless
 * bundle lays out static files.
 */
export async function GET() {
  const png = Buffer.from(ARCHITECTURE_PNG_BASE64, 'base64')
  return new Response(new Uint8Array(png), {
    status: 200,
    headers: {
      'Content-Type': 'image/png',
      'Content-Length': String(png.byteLength),
      'Content-Disposition': 'inline; filename="conffit-architecture.png"',
      'Cache-Control': 'public, max-age=3600, s-maxage=86400',
    },
  })
}
