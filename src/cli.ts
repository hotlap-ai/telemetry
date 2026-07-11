#!/usr/bin/env bun

import { parseArgs } from 'util';
import { VERSION } from './constants';
import { IBT, parseIbt } from './ibt';
import { IRSDK, createIRSDK } from './live';

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    version: { type: 'boolean', short: 'v' },
    help: { type: 'boolean', short: 'h' },
    test: { type: 'string', short: 't' },
    dump: { type: 'string', short: 'd' },
    parse: { type: 'string', short: 'p' },
    info: { type: 'boolean', short: 'i' },
    vars: { type: 'boolean' },
    get: { type: 'string', short: 'g' },
    'get-all': { type: 'string' },
    session: { type: 'string', short: 's' },
    output: { type: 'string', short: 'o' },
    format: { type: 'string', short: 'f' },
    live: { type: 'boolean', short: 'l' },
  },
  allowPositionals: true,
});

function printHelp(): void {
  console.log(`
HotLap.ai Telemetry CLI v${VERSION}

Usage: irsdk [options] [file.ibt]

Options:
  -v, --version        Show version
  -h, --help           Show help
  -t, --test <file>    Use test file as IRSDK memory map
  -d, --dump <file>    Dump IRSDK memory map to file
  -p, --parse <file>   Parse IBT file and output to file
  -i, --info           Show file/session info
  --vars               List all available variables
  -g, --get <var>      Get a single variable value
  --get-all <var>      Get all values of a variable (IBT only)
  -s, --session <key>  Get session info by key
  -o, --output <file>  Output file for export
  -f, --format <fmt>   Output format: json, csv, ndjson (default: json)
  -l, --live           Connect to live iRacing session

Examples:
  irsdk mytelemetry.ibt --info
  irsdk mytelemetry.ibt --vars
  irsdk mytelemetry.ibt -g Speed
  irsdk mytelemetry.ibt --get-all Speed -o speed.json
  irsdk mytelemetry.ibt -s WeekendInfo
  irsdk --live -g Speed
  irsdk --test dump.bin -g Throttle
`);
}

async function main(): Promise<void> {
  if (values.version) {
    console.log(`HotLap.ai Telemetry CLI v${VERSION}`);
    return;
  }

  if (values.help) {
    printHelp();
    return;
  }

  const ibtFile = positionals[0];

  if (values.live) {
    await runLive();
    return;
  }

  if (ibtFile) {
    await processIbtFile(ibtFile);
    return;
  }

  if (values.test || values.dump) {
    await runWithTestFile();
    return;
  }

  printHelp();
}

async function runLive(): Promise<void> {
  const ir = createIRSDK();
  const connected = await ir.startup(values.test, values.dump);

  if (!connected) {
    console.error('Failed to connect to iRacing');
    process.exit(1);
  }

  console.log('Connected to iRacing');

  if (values.vars) {
    const names = ir.varHeaderNames;
    if (names) {
      console.log('\nAvailable variables:');
      for (const name of names.sort()) {
        console.log(`  ${name}`);
      }
    }
    ir.shutdown();
    return;
  }

  if (values.get) {
    const value = ir.get(values.get);
    console.log(`${values.get}: ${JSON.stringify(value)}`);
    ir.shutdown();
    return;
  }

  if (values.session) {
    const info = ir.getSessionInfo(values.session);
    console.log(JSON.stringify(info, null, 2));
    ir.shutdown();
    return;
  }

  console.log('\nBasic telemetry:');
  const vars = ['Speed', 'RPM', 'Gear', 'Throttle', 'Brake', 'Lap', 'LapDistPct'];
  for (const v of vars) {
    const value = ir.get(v);
    if (value !== null) {
      console.log(`  ${v}: ${value}`);
    }
  }

  ir.shutdown();
}

async function processIbtFile(filePath: string): Promise<void> {
  console.log(`Opening ${filePath}...`);
  const ibt = await parseIbt(filePath);

  if (values.info) {
    console.log('\nFile Info:');
    console.log(`  Records: ${ibt.recordCount}`);
    console.log(`  Laps: ${ibt.sessionLapCount}`);
    console.log(`  Tick Rate: ${ibt.tickRate} Hz`);
    console.log(`  Duration: ${((ibt.sessionEndTime - ibt.sessionStartTime) / 60).toFixed(2)} minutes`);
    console.log(`  Buffer Length: ${ibt.bufLen} bytes`);

    const weekendInfo = ibt.getSessionInfo<{ TrackDisplayName?: string; TrackName?: string }>('WeekendInfo');
    if (weekendInfo) {
      console.log(`  Track: ${weekendInfo.TrackDisplayName || weekendInfo.TrackName || 'Unknown'}`);
    }

    const driverInfo = ibt.getSessionInfo<{ Drivers?: Array<{ UserName?: string; CarScreenName?: string }> }>('DriverInfo');
    if (driverInfo?.Drivers?.[0]) {
      console.log(`  Driver: ${driverInfo.Drivers[0].UserName || 'Unknown'}`);
      console.log(`  Car: ${driverInfo.Drivers[0].CarScreenName || 'Unknown'}`);
    }

    ibt.close();
    return;
  }

  if (values.vars) {
    const names = ibt.varHeaderNames;
    if (names) {
      console.log('\nAvailable variables:');
      for (const name of names.sort()) {
        const header = ibt.getVarHeader(name);
        console.log(`  ${name.padEnd(30)} ${header?.unit || ''} (${header?.desc || ''})`);
      }
    }
    ibt.close();
    return;
  }

  if (values.get) {
    const value = ibt.get(ibt.recordCount - 1, values.get);
    console.log(`${values.get} (last record): ${JSON.stringify(value)}`);
    ibt.close();
    return;
  }

  if (values['get-all']) {
    const varName = values['get-all'];
    console.log(`Getting all values for ${varName}...`);

    const data = ibt.getAllTyped(varName) ?? ibt.getAll(varName);
    if (!data) {
      console.error(`Variable ${varName} not found`);
      ibt.close();
      process.exit(1);
    }

    const format = values.format || 'json';
    const output = values.output;

    let content: string;
    if (format === 'csv') {
      content = `index,${varName}\n` + Array.from(data).map((v, i) => `${i},${v}`).join('\n');
    } else if (format === 'ndjson') {
      content = Array.from(data).map((v, i) => JSON.stringify({ index: i, [varName]: v })).join('\n');
    } else {
      content = JSON.stringify({ variable: varName, count: data.length, data: Array.from(data) }, null, 2);
    }

    if (output) {
      await Bun.write(output, content);
      console.log(`Written to ${output}`);
    } else {
      console.log(content);
    }

    ibt.close();
    return;
  }

  if (values.session) {
    const info = ibt.getSessionInfo(values.session);
    if (info) {
      console.log(JSON.stringify(info, null, 2));
    } else {
      console.error(`Session key ${values.session} not found`);
    }
    ibt.close();
    return;
  }

  if (values.parse) {
    console.log(`Parsing to ${values.parse}...`);
    const output: string[] = [];

    const rawSession = ibt.getRawSessionInfo();
    if (rawSession) {
      output.push(rawSession);
      output.push('\n--- Variables ---\n');
    }

    const names = ibt.varHeaderNames?.sort() ?? [];
    for (const name of names) {
      const value = ibt.get(ibt.recordCount - 1, name);
      output.push(`${name.padEnd(32)}${JSON.stringify(value)}`);
    }

    await Bun.write(values.parse, output.join('\n'));
    console.log('Done');
    ibt.close();
    return;
  }

  console.log('\nUse --info, --vars, --get, --get-all, or --session to explore the file');
  ibt.close();
}

async function runWithTestFile(): Promise<void> {
  const ir = createIRSDK();
  const connected = await ir.startup(values.test, values.dump);

  if (!connected) {
    console.error('Failed to initialize from test file');
    process.exit(1);
  }

  if (values.dump) {
    console.log(`Dumped to ${values.dump}`);
  }

  if (values.get) {
    const value = ir.get(values.get);
    console.log(`${values.get}: ${JSON.stringify(value)}`);
  }

  ir.shutdown();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
