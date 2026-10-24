/**
 * `map/seasons.txt` for a world whose climate the model declares (ADR 0057). The file has a block
 * per season with a hue, saturation and value (`hsv_*`) and a colour balance (`colorbalance_*`) for
 * a north, a centre and a south band, plus the periods in which the trees change. The base game
 * desaturates its north band to 0.1 in every season; a model whose cold band is mild keeps more of
 * its colour, and the strength of the winter tint follows the model's seasonality. Where the
 * band edges lie on the map is not stated in any file this tool reads (plan: unverified), so the
 * centre and south bands stay as in the base game.
 */
import type { ResolvedClimate } from '../geography/index.js';
import { smoothstep01 } from '../stable-math.js';

/** Saturation of the north band: 0.1 for a polar band of -12 degrees or colder, 0.85 from +6. */
export function northSaturation(climate: Pick<ResolvedClimate, 'temperature'>): number {
  return 0.1 + 0.75 * smoothstep01((climate.temperature.cold + 12) / 18);
}

const SEASONS: ReadonlyArray<readonly [string, string, string]> = [
  ['winter', '00.12.01', '00.02.10'],
  ['spring', '00.03.10', '00.04.22'],
  ['summer', '00.05.20', '00.09.10'],
  ['autumn', '00.10.10', '00.10.31'],
];

const TREE_PERIODS: ReadonlyArray<readonly [string, string, string]> = [
  ['tree_winter', '00.11.15', '00.12.01'],
  ['tree_winter2', '00.12.20', '00.01.20'],
  ['tree_spring', '00.02.20', '00.03.01'],
  ['tree_spring2', '00.03.20', '00.04.20'],
  ['tree_summer', '00.05.20', '00.06.01'],
  ['tree_summer2', '00.06.20', '00.09.10'],
  ['tree_autumn', '00.10.01', '00.10.10'],
  ['tree_autumn2', '00.10.25', '00.11.01'],
];

function fixed(value: number): string {
  return (Math.round(value * 1000) / 1000).toString();
}

/** The text of `seasons.txt` for a climate. */
export function seasonsFile(climate: ResolvedClimate): string {
  const saturation = northSaturation(climate);
  const balance = 1 - 0.2 * climate.seasonality;
  const lines: string[] = [
    '# Generated from the geography model climate (north band saturation follows the cold band,',
    '# the tint of the north band follows the seasonality). Centre and south are the base game\'s.',
    '',
  ];
  for (const [name, start, end] of SEASONS)
    lines.push(
      `${name} = {`,
      `\tstart_date=${start}`,
      `\tend_date=${end}`,
      '',
      `\thsv_north=\t\t\t { 0 ${fixed(saturation)} 1 }`,
      `\tcolorbalance_north=\t { ${fixed(balance)} ${fixed(balance)} 1 }`,
      '',
      '\thsv_center=\t\t\t { 0.0 1.0 1.0 }',
      '\tcolorbalance_center= { 1.0 1.0 1.0 }',
      '',
      '\thsv_south=\t\t\t { 0.0 1.0 1.0 }',
      '\tcolorbalance_south=\t { 1.0 1.0 1.0 }',
      '}',
      '',
    );
  for (const [name, start, end] of TREE_PERIODS)
    lines.push(`${name} = {`, `\tstart_date=${start}`, `\tend_date=${end}`, '}');
  lines.push('');
  return lines.join('\n');
}
