import { describe, expect, it } from 'vitest';
import { parseClausewitz } from '../../src/hoi4_agent_tools/core/source/index.js';
import {
  activeKnownMistakes,
  knownMistakeDetectorIds,
  knownMistakeFindings,
  knownMistakeForLogMessage,
  knownMistakeRules,
  type KnownMistakeRule,
} from '../../src/hoi4_agent_tools/reference/known-mistakes.js';

function codes(family: string, source: string, namespaces: string[] = []): string[] {
  const document = parseClausewitz(Buffer.from(source), 'test.txt');
  return knownMistakeFindings(family, document, { eventNamespaces: new Set(namespaces) }).map(
    ({ code }) => code,
  );
}

describe('the reviewed known-mistake list', () => {
  it('cites a source for every rule and has a detector for each active one', () => {
    for (const rule of knownMistakeRules) {
      expect(rule.sources.length, rule.id).toBeGreaterThan(0);
      expect(rule.fix.length, rule.id).toBeGreaterThan(10);
    }
    expect(new Set(knownMistakeRules.map(({ id }) => id)).size).toBe(knownMistakeRules.length);
    const active = activeKnownMistakes().map(({ id }) => id);
    for (const id of active) expect(knownMistakeDetectorIds, id).toContain(id);
    for (const id of knownMistakeDetectorIds)
      expect(
        knownMistakeRules.map((rule) => rule.id),
        id,
      ).toContain(id);
  });

  it('lists a surface only its own rules and keeps resolved rules out of use', () => {
    const resolved: KnownMistakeRule = {
      ...knownMistakeRules[0]!,
      id: 'old_engine_bug',
      status: 'resolved',
      resolution: { date: '2026-10-10', note: 'The game fixed this in a later patch.' },
    };
    const rules = [...knownMistakeRules, resolved];
    expect(activeKnownMistakes('gui', rules)).toEqual([]);
    expect(activeKnownMistakes('event').length).toBeGreaterThan(3);
    expect(activeKnownMistakes('decision').map(({ id }) => id)).toEqual([
      'temp_variable_scope_prefix',
    ]);
    expect(activeKnownMistakes(undefined, rules).some(({ id }) => id === 'old_engine_bug')).toBe(
      false,
    );
    const document = parseClausewitz(
      Buffer.from('add_namespace = a\ncountry_event = { id = a.x }\n'),
      'e.txt',
    );
    expect(
      knownMistakeFindings('events', document, { eventNamespaces: new Set(['a']) }, [resolved]),
    ).toEqual([]);
  });

  it('names a rule and its fix for the game messages it explains', () => {
    expect(
      knownMistakeForLogMessage('Event is triggered only, but does not have a 1 base-factor.')?.id,
    ).toBe('event_triggered_only_with_mtth');
    expect(knownMistakeForLogMessage('Malformed token: my_event.12, near line 4')?.id).toBe(
      'event_namespace_missing',
    );
    expect(knownMistakeForLogMessage('Unrelated engine message')).toBeUndefined();
  });
});

describe('known-mistake detectors', () => {
  it('flags a timer on a triggered-only event and accepts the corrected events', () => {
    const broken =
      'add_namespace = a\ncountry_event = { id = a.1 is_triggered_only = yes mean_time_to_happen = { days = 5 } }\n';
    expect(codes('events', broken)).toEqual(['KNOWN_MISTAKE_EVENT_TRIGGERED_ONLY_WITH_MTTH']);
    const fixed =
      'add_namespace = a\ncountry_event = { id = a.1 mean_time_to_happen = { days = 5 } }\ncountry_event = { id = a.2 is_triggered_only = yes }\n';
    expect(codes('events', fixed)).toEqual([]);
  });

  it('flags automatic events that can fire every day', () => {
    const source = [
      'add_namespace = a',
      'country_event = { id = a.1 trigger = { always = yes } }',
      'country_event = { id = a.2 mean_time_to_happen = { days = 1 } }',
      'country_event = { id = a.3 mean_time_to_happen = { days = 90 } }',
      'country_event = { id = a.4 fire_only_once = yes }',
      'country_event = { id = a.5 is_triggered_only = yes }',
      'country_event = { id = a.6 mean_time_to_happen = { months = 2 } }',
      '',
    ].join('\n');
    const document = parseClausewitz(Buffer.from(source), 'e.txt');
    const lines = knownMistakeFindings('events', document, {
      eventNamespaces: new Set(['a']),
    }).map(({ code, offset }) => [code, source.slice(0, offset).split('\n').length]);
    expect(lines).toEqual([
      ['KNOWN_MISTAKE_EVENT_FIRES_EVERY_DAY', 2],
      ['KNOWN_MISTAKE_EVENT_FIRES_EVERY_DAY', 3],
    ]);
  });

  it('flags news events that are not major or fire only once', () => {
    const source = [
      'add_namespace = a',
      'news_event = { id = a.1 is_triggered_only = yes }',
      'news_event = { id = a.2 is_triggered_only = yes major = yes fire_only_once = yes }',
      'news_event = { id = a.3 is_triggered_only = yes major = yes }',
      'country_event = { id = a.4 is_triggered_only = yes }',
      '',
    ].join('\n');
    expect(codes('events', source)).toEqual([
      'KNOWN_MISTAKE_NEWS_EVENT_NOT_MAJOR',
      'KNOWN_MISTAKE_NEWS_EVENT_NOT_MAJOR',
    ]);
  });

  it('flags a date window that the 20-day check can skip', () => {
    const tight =
      'add_namespace = a\ncountry_event = { id = a.1 trigger = { date > 1936.1.1 date < 1936.1.3 } mean_time_to_happen = { days = 3 } }\n';
    expect(codes('events', tight)).toEqual(['KNOWN_MISTAKE_EVENT_DATE_WINDOW_TOO_TIGHT']);
    const wide =
      'add_namespace = a\ncountry_event = { id = a.1 trigger = { date > 1936.1.1 date < 1936.3.1 } mean_time_to_happen = { days = 3 } }\n';
    expect(codes('events', wide)).toEqual([]);
    const triggeredOnly =
      'add_namespace = a\ncountry_event = { id = a.1 is_triggered_only = yes trigger = { date > 1936.1.1 date < 1936.1.3 } }\n';
    expect(codes('events', triggeredOnly)).toEqual([]);
  });

  it('flags undeclared namespaces, using namespaces declared in other files', () => {
    const source = 'country_event = { id = other.1 is_triggered_only = yes }\n';
    expect(codes('events', source)).toEqual(['KNOWN_MISTAKE_EVENT_NAMESPACE_MISSING']);
    expect(codes('events', source, ['other'])).toEqual([]);
    expect(
      codes(
        'events',
        'add_namespace = a.b\ncountry_event = { id = a.b.7 is_triggered_only = yes }\n',
      ),
    ).toEqual([]);
  });

  it('flags event numbers that are not whole numbers below 100000', () => {
    const source = [
      'add_namespace = a',
      'country_event = { id = a.abc is_triggered_only = yes }',
      'country_event = { id = a.100000 is_triggered_only = yes }',
      'country_event = { id = a.99999 is_triggered_only = yes }',
      'country_event = { id = a.0 is_triggered_only = yes }',
      '',
    ].join('\n');
    expect(codes('events', source)).toEqual([
      'KNOWN_MISTAKE_EVENT_NUMERIC_ID_INVALID',
      'KNOWN_MISTAKE_EVENT_NUMERIC_ID_INVALID',
    ]);
  });

  it('flags a scope prefix on a variable that is only ever temporary', () => {
    const source = [
      'a_effect = {',
      '\tset_temp_variable = { amount = 5 }',
      '\tset_variable = { stored = 1 }',
      '\tROOT = {',
      '\t\tadd_to_variable = { stored = ROOT.amount }',
      '\t\tadd_to_variable = { stored = ROOT.stored }',
      '\t\tadd_to_variable = { stored = amount }',
      '\t\tadd_to_variable = { stored = 0.5 }',
      '\t}',
      '}',
      '',
    ].join('\n');
    const document = parseClausewitz(Buffer.from(source), 'e.txt');
    const findings = knownMistakeFindings('scripted_effects', document);
    expect(findings.map(({ code }) => code)).toEqual(['KNOWN_MISTAKE_TEMP_VARIABLE_SCOPE_PREFIX']);
    expect(findings[0]!.message).toContain('ROOT.amount');
    // A script constant read is not a scoped variable read, even when its key matches a temporary.
    expect(
      codes(
        'scripted_effects',
        'a = { set_temp_variable = { event_id = 1 } b = { c = constant:random_identity.event_id } }\n',
      ),
    ).toEqual([]);
    // A name that is also a regular variable in the file is not reported.
    expect(
      codes(
        'scripted_effects',
        'a = { set_temp_variable = { n = 1 } set_variable = { n = 1 } b = { c = ROOT.n } }\n',
      ),
    ).toEqual([]);
  });
});
