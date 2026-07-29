import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The agent runtime uses Node built-ins (Buffer, crypto) and the Supabase /
  // Pinecone SDKs, so every route runs on the Node.js runtime, not Edge.
  /*
   * pdf.js has to stay external too: bundling it leaves its worker file behind
   * ("Setting up fake worker failed"), so every PDF the author uploads would be
   * reported as unreadable. Externalising it lets Node resolve the worker from
   * node_modules at runtime, which Vercel traces into the function.
   */
  serverExternalPackages: ['@pinecone-database/pinecone', 'pdfjs-dist'],
}

export default nextConfig
