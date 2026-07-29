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
  /*
   * pdf.js loads its worker by path at runtime, so nothing references
   * pdf.worker.mjs statically and Vercel's file tracing leaves it out of the
   * function. The deployed build then failed every upload with "Setting up fake
   * worker failed" while working locally, where node_modules is simply present.
   */
  outputFileTracingIncludes: {
    '/api/execute': ['./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs'],
  },
}

export default nextConfig
