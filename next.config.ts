import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The agent runtime uses Node built-ins (Buffer, crypto) and the Supabase /
  // Pinecone SDKs, so every route runs on the Node.js runtime, not Edge.
  serverExternalPackages: ['@pinecone-database/pinecone'],
}

export default nextConfig
