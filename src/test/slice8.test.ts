import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { RecentProject, addRecent, normalizePath, projectChoices, projectKey, samePath } from '../ui/projects';
import { parseMessage } from '../ui/messages';

const P = (...parts: string[]) => path.resolve(path.sep, ...parts);

describe('project paths', () => {
  it('compares paths ignoring trailing separators (and case on Windows)', () => {
    expect(samePath(P('a', 'b'), P('a', 'b') + path.sep)).toBe(true);
    expect(samePath(P('a', 'b'), P('a', 'c'))).toBe(false);
    if (process.platform === 'win32') {
      expect(samePath('D:\\Product\\Mass_Delete', 'd:\\product\\mass_delete\\')).toBe(true);
    }
    expect(normalizePath(P('x', '..', 'y'))).toBe(normalizePath(P('y')));
  });

  it('gives every project its own stable, distinct state key', () => {
    const a = projectKey(P('work', 'alpha'));
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(projectKey(P('work', 'alpha') + path.sep)).toBe(a);
    expect(projectKey(P('work', 'beta'))).not.toBe(a);
  });
});

describe('recent projects', () => {
  const now = new Date('2026-10-22T10:00:00Z');
  it('puts the newest first, de-duplicates and caps the list', () => {
    let list: RecentProject[] = [];
    list = addRecent(list, P('p', 'one'), now);
    list = addRecent(list, P('p', 'two'), now);
    list = addRecent(list, P('p', 'one') + path.sep, new Date('2026-10-22T11:00:00Z'));
    expect(list.map(r => r.name)).toEqual(['one', 'two']);
    expect(list[0].lastUsed).toBe('2026-10-22T11:00:00.000Z');
    for (let i = 0; i < 20; i++) { list = addRecent(list, P('p', `proj${i}`), now); }
    expect(list).toHaveLength(10);
    expect(list[0].name).toBe('proj19');
  });
});

describe('projectChoices', () => {
  const recents = (...names: string[]): RecentProject[] => names.map(n => ({ path: P('r', n), name: n, lastUsed: 'x' }));
  it('lists workspace folders first, then recents that still exist, without duplicates', () => {
    const choices = projectChoices([P('w', 'open')], [...recents('gone', 'kept'), { path: P('w', 'open'), name: 'open', lastUsed: 'x' }], p => !p.endsWith('gone'));
    expect(choices.map(c => [c.name, c.source])).toEqual([['open', 'workspace'], ['kept', 'recent']]);
  });
  it('disambiguates projects that share a folder name', () => {
    const choices = projectChoices([P('a', 'app')], recents('x').map(r => ({ ...r, path: P('b', 'app'), name: 'app' })), () => true);
    expect(choices.map(c => c.label)).toEqual(['app (a)', 'app (b)']);
    expect(projectChoices([P('only', 'one')], [], () => true)[0].label).toBe('one');
  });
});

describe('slice 8 message validation', () => {
  it('accepts a project switch and the browse action', () => {
    expect(parseMessage({ type: 'browseProject' })).toEqual({ type: 'browseProject' });
    expect(parseMessage({ type: 'selectFolder', path: 'D:\\Product\\Mass_Delete' })).toBeDefined();
    expect(parseMessage({ type: 'selectFolder', path: 'a\nb' })).toBeUndefined();
  });
});
