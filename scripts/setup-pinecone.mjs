#!/usr/bin/env node
/**
 * Creates the Pinecone index ConfFit expects, if it does not already exist.
 *
 *   PINECONE_API_KEY=... node scripts/setup-pinecone.mjs
 *
 * text-embedding-3-small produces 1536-dimensional vectors and we compare with
 * cosine similarity, so those are the index parameters.
 */
import { Pinecone } from '@pinecone-database/pinecone'

const apiKey = process.env.PINECONE_API_KEY
const name = process.env.PINECONE_INDEX || 'conffit'

if (!apiKey) {
  console.error('PINECONE_API_KEY is not set. Export it and re-run.')
  process.exit(1)
}

const pc = new Pinecone({ apiKey })
const { indexes = [] } = await pc.listIndexes()

if (indexes.some((i) => i.name === name)) {
  const desc = await pc.describeIndex(name)
  console.log(`Index "${name}" already exists (dimension ${desc.dimension}, metric ${desc.metric}).`)
  if (desc.dimension !== 1536) {
    console.error(`  ! Expected dimension 1536 for text-embedding-3-small; found ${desc.dimension}.`)
    process.exit(1)
  }
  process.exit(0)
}

console.log(`Creating index "${name}" (1536 dimensions, cosine, serverless aws/us-east-1)…`)
await pc.createIndex({
  name,
  dimension: 1536,
  metric: 'cosine',
  spec: { serverless: { cloud: 'aws', region: 'us-east-1' } },
  waitUntilReady: true,
})
console.log('Ready.')
