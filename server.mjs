#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  projectsDir, listProjects, loadProject, runAsk, terminateAll, createSerializer, startProgress,
} from './lib.mjs';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const PROGRESS_INTERVAL_MS = 15000;
const USAGE = `Usage:
  node server.mjs                      start the MCP server on stdio
  node server.mjs list                 list projects
  node server.mjs ask <project> "<q>"  ask one question`;

const questionSchema = z.string().min(1).max(4000);
const serialize = createSerializer();

async function ask(projectName, question) {
  const project = await loadProject(projectsDir(), projectName);
  return serialize(project.name, () => runAsk(project, question));
}

let shuttingDown = false;
async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  await terminateAll();
  process.exit(code);
}

function serve() {
  const server = new McpServer({ name: 'cowork-data-bridge', version });

  server.registerTool('list_projects', {
    description: 'List the projects whose data can be queried with `ask`, with a short description of each.',
    annotations: { readOnlyHint: true },
  }, async () => ({
    content: [{ type: 'text', text: JSON.stringify(await listProjects(projectsDir()), null, 2) }],
  }));

  server.registerTool('ask', {
    description: 'Ask a natural-language question about a project\'s data. A read-only analyst with the project\'s '
      + 'code and database answers it, which can take several minutes. Each call is independent: include all '
      + 'context (period, filters, desired breakdown) in the question.',
    inputSchema: {
      project: z.string().describe('Project name from list_projects'),
      question: questionSchema.describe('The question, self-contained, in any language'),
    },
    annotations: { readOnlyHint: true },
  }, async ({ project, question }, extra) => {
    const progressToken = extra._meta?.progressToken;
    const stopProgress = progressToken === undefined ? () => {} : startProgress((n) => extra.sendNotification({
      method: 'notifications/progress',
      params: { progressToken, progress: n, message: `Still working (${(n * PROGRESS_INTERVAL_MS) / 1000}s)` },
    }), PROGRESS_INTERVAL_MS);
    try {
      const result = await ask(project, question);
      return result.ok
        ? { content: [{ type: 'text', text: result.text }] }
        : { content: [{ type: 'text', text: result.message }], isError: true };
    } catch (err) {
      return { content: [{ type: 'text', text: err.message }], isError: true };
    } finally {
      stopProgress();
    }
  });

  process.stdin.on('end', () => shutdown(0));
  return server.connect(new StdioServerTransport());
}

async function cli([command, ...rest]) {
  if (command === 'list' && rest.length === 0) {
    console.log(JSON.stringify(await listProjects(projectsDir()), null, 2));
    return 0;
  }
  if (command === 'ask' && rest.length === 2) {
    const [project, question] = rest;
    try {
      questionSchema.parse(question);
      const result = await ask(project, question);
      if (result.ok) {
        console.log(result.text);
        return 0;
      }
      console.error(result.message);
    } catch (err) {
      console.error(err instanceof z.ZodError ? 'question must be 1-4000 characters' : err.message);
    }
    return 1;
  }
  console.error(USAGE);
  return 2;
}

process.on('SIGINT', () => shutdown(130));
process.on('SIGTERM', () => shutdown(143));

const args = process.argv.slice(2);
if (args.length === 0) {
  await serve();
} else {
  process.exitCode = await cli(args);
}
