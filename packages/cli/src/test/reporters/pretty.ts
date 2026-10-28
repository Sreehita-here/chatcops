import { styleText } from 'node:util';
import { dollars } from '../cost.js';
import { getTestDurationMs } from '../run.js';
import type { AssertionResult, TestResult } from '../types.js';
import type { Reporter, ReporterFactory, ReporterOutput, RunSummary } from './index.js';

interface PrettyReportOptions {
  verbose?: boolean;
  env?: Record<string, string | undefined>;
}

export interface PrettyRunDetails {
  model?: string;
  elapsedMs: number;
  costIncomplete: boolean;
}

type ConfiguredPrettyReporter = Reporter & { setRunDetails(details: PrettyRunDetails): void };

export function createPrettyReporter(output: ReporterOutput, options: PrettyReportOptions = {}): ConfiguredPrettyReporter {
  const env = options.env ?? process.env;
  const colors = 'isTTY' in output && output.isTTY === true && env.NO_COLOR === undefined;
  const paint = (color: 'cyan' | 'green' | 'red' | 'gray', text: string) => (colors ? styleText(color, text, { validateStream: false }) : text);
  let details: PrettyRunDetails | undefined;

  return {
    onEnd(results, summary) {
      output.write(prettyReport(results, summary, details, options.verbose === true, paint));
    },
    setRunDetails(value) {
      details = value;
    },
  };
}

/** For people: a grouped report with assertion details when useful. */
export const prettyReporter: ReporterFactory = (output) => createPrettyReporter(output);

function prettyReport(
  results: TestResult[],
  summary: RunSummary,
  details: PrettyRunDetails | undefined,
  verbose: boolean,
  paint: (color: 'cyan' | 'green' | 'red' | 'gray', text: string) => string
): string {
  const lines = [
    '',
    paint('cyan', 'ChatCops evaluations'),
    paint('gray', '────────────────────────────────────────'),
    paint('gray', `Model: ${details?.model ?? 'unavailable'}`),
    ...(summary.judge ? [paint('gray', `Judge: ${summary.judge}`)] : []),
    paint('gray', `Mode: ${summary.mode === 'record' ? 'recorded' : summary.mode}`),
    '',
  ];
  const groups = new Map<string, TestResult[]>();
  for (const result of results) {
    const group = groups.get(result.fixture) ?? [];
    group.push(result);
    groups.set(result.fixture, group);
  }

  for (const [fixture, tests] of groups) {
    lines.push(paint('cyan', fixture));
    for (const result of tests) {
      const status = result.pass ? paint('green', '✓') : paint('red', '✗');
      const rate = result.runs.length > 1 ? ` (${result.runs.filter((run) => run.pass).length}/${result.runs.length} runs)` : '';
      const elapsed = getTestDurationMs(result);
      const duration = elapsed === undefined ? '' : `  ${formatDuration(elapsed)}`;
      lines.push(`  ${status} ${result.test}${rate}${duration}`);
      if (!result.pass || verbose) {
        appendDetails(lines, result, paint);
        lines.push('');
      }
    }
    if (lines.at(-1) !== '') lines.push('');
  }

  const failed = results.filter((result) => !result.pass).length;
  const assertions = results.flatMap((result) => result.runs.flatMap((run) => run.turns.flatMap(({ results: checks }) => checks)));
  const passedAssertions = assertions.filter((check) => check.pass).length;
  const cost =
    summary.mode === 'replay'
      ? ' Replayed, nothing spent.'
      : summary.costUsd === undefined
        ? ' Cost unavailable.'
        : details?.costIncomplete
          ? ` Spent about ${dollars(summary.costUsd)} (partial; some calls could not be priced).`
          : ` Spent about ${dollars(summary.costUsd)}.`;
  const judge = summary.judge ? ` Judged by ${summary.judge}.` : '';
  lines.push(
    paint('cyan', 'Summary'),
    paint('gray', '────────────────────────────────────────'),
    `${paint('green', `${results.length - failed} passed`)}, ${paint(failed ? 'red' : 'gray', `${failed} failed`)}.${cost}${judge}`,
    `Assertions: ${passedAssertions} passed, ${assertions.length - passedAssertions} failed`,
    formatUsage(results),
    paint('gray', `Elapsed: ${formatDuration(details?.elapsedMs)}`),
  );
  return `${lines.join('\n')}\n`;
}

function appendDetails(
  lines: string[],
  result: TestResult,
  paint: (color: 'cyan' | 'green' | 'red' | 'gray', text: string) => string
): void {
  for (const run of result.runs) {
    for (const [index, { turn, results: checks }] of run.turns.entries()) {
      lines.push(paint('gray', `    Run ${run.run} · Turn ${index + 1}`));
      if (!checks.length) lines.push(paint('gray', '      No assertions for this turn.'));
      for (const check of checks) {
        const status = check.pass ? paint('green', '✓') : paint('red', '✗');
        const wrapped = wrapText(`turn ${index + 1}: ${reason(check)}`, 76);
        lines.push(`      ${status} ${wrapped[0]}`);
        for (const continuation of wrapped.slice(1)) lines.push(`        ${continuation}`);
      }
      if (checks.some((check) => !check.pass)) {
        lines.push(paint('gray', `      reply: ${clip(turn.text)}`));
      }
    }
    if (run.error) lines.push(`    Run ${run.run}: ${run.error}`);
  }
}

/** Wrap long explanations without losing words or relying on ANSI string widths. */
function wrapText(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line && line.length + word.length + 1 > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  lines.push(line);
  return lines;
}

function reason(check: AssertionResult): string {
  return check.reason ?? Object.keys(check.assertion)[0];
}

function formatUsage(results: TestResult[]): string {
  const turns = results.flatMap((result) => result.runs.flatMap((run) => run.turns.map(({ turn }) => turn)));
  const reported = turns.flatMap((turn) => (turn.usage ? [turn.usage] : []));
  if (!reported.length) return 'Bot tokens: unavailable (not reported)';
  const input = reported.reduce((total, usage) => total + usage.inputTokens, 0);
  const output = reported.reduce((total, usage) => total + usage.outputTokens, 0);
  const partial = reported.length < turns.length ? ` (partial; reported for ${reported.length} of ${turns.length} turns)` : '';
  return `Bot tokens${partial}: ${input} input + ${output} output = ${input + output} total`;
}

function formatDuration(milliseconds: number | undefined): string {
  if (milliseconds === undefined) return 'unavailable';
  return milliseconds < 1000 ? `${Math.round(milliseconds)} ms` : `${(milliseconds / 1000).toFixed(2)} s`;
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat ? (flat.length > 200 ? `${flat.slice(0, 199)}…` : flat) : '(empty)';
}
