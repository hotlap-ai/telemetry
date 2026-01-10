import { bench, run, group } from 'mitata';
import { parseIbt, IBT } from '../src/ibt';

const TEST_FILE = process.argv[2] || './test.ibt';

async function main() {
  console.log(`Benchmarking with file: ${TEST_FILE}`);

  let ibt: IBT | null = null;

  try {
    ibt = await parseIbt(TEST_FILE);
    console.log(`File loaded: ${ibt.recordCount} records, ${ibt.varHeaderNames?.length} variables`);
  } catch (err) {
    console.error('Failed to load test file:', err);
    console.log('\nUsage: bun run bench/parse-ibt.bench.ts <path-to-ibt-file>');
    process.exit(1);
  }

  group('File Operations', () => {
    bench('parseIbt (open file)', async () => {
      const newIbt = await parseIbt(TEST_FILE);
      newIbt.close();
    });

    bench('IBT.fromBuffer', async () => {
      const file = Bun.file(TEST_FILE);
      const buffer = await file.arrayBuffer();
      const newIbt = await IBT.fromBuffer(buffer);
      newIbt.close();
    });
  });

  group('Single Value Access', () => {
    bench('get single value (first record)', () => {
      ibt!.get(0, 'Speed');
    });

    bench('get single value (last record)', () => {
      ibt!.get(ibt!.recordCount - 1, 'Speed');
    });

    bench('get single value (middle)', () => {
      ibt!.get(Math.floor(ibt!.recordCount / 2), 'Speed');
    });
  });

  group('Bulk Data Access', () => {
    bench('getAll (Speed)', () => {
      ibt!.getAll('Speed');
    });

    bench('getAllTyped (Speed) - Float32Array', () => {
      ibt!.getAllTyped('Speed');
    });

    bench('getAllMultiple (5 vars)', () => {
      ibt!.getAllMultiple(['Speed', 'RPM', 'Throttle', 'Brake', 'Gear']);
    });
  });

  group('Iterator', () => {
    bench('iterate 1000 records (5 vars)', () => {
      const iter = ibt!.iterate(['Speed', 'RPM', 'Throttle', 'Brake', 'Gear']);
      let count = 0;
      for (const record of iter) {
        if (++count >= 1000) break;
      }
    });
  });

  group('Session Info', () => {
    bench('getRawSessionInfo', () => {
      ibt!.getRawSessionInfo();
    });

    bench('getSessionInfo (WeekendInfo)', () => {
      ibt!.getSessionInfo('WeekendInfo');
    });

    bench('getSessionInfo (DriverInfo)', () => {
      ibt!.getSessionInfo('DriverInfo');
    });
  });

  await run({
    avg: true,
    json: false,
    colors: true,
    min_max: true,
    percentiles: true,
  });

  ibt?.close();
}

main();
