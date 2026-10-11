import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { readFile } from 'node:fs/promises';

const base = process.env.INDRI_URL || 'http://127.0.0.1:4317';
const client = new Client({ name: 'indri-demo', version: '0.1.0' });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  for (const file of ['architecture.json', 'login-sketch.json']) {
    const graph = JSON.parse(await readFile(new URL(`../examples/${file}`, import.meta.url), 'utf8'));
    const result = await client.callTool({ name: 'create_diagram', arguments: { graph } });
    if (result.isError) throw new Error(result.content[0].text);
    console.log(`${graph.title}\n${result.structuredContent.review_url}\n`);
  }
} finally { await client.close(); }
