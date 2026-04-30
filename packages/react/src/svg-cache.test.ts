import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadMark, clearSvgCache } from './svg-cache';

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0 L10 10"/></svg>';

const okResponse = (text: string): Response =>
  ({
    ok: true,
    status: 200,
    statusText: 'OK',
    text: () => Promise.resolve(text),
  }) as unknown as Response;

const errResponse = (status: number, statusText: string): Response =>
  ({
    ok: false,
    status,
    statusText,
    text: () => Promise.resolve(''),
  }) as unknown as Response;

describe('loadMark', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    clearSvgCache();
    fetchSpy = vi.fn().mockResolvedValue(okResponse(SVG));
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the same Promise for the same src (memoization)', () => {
    const a = loadMark('/foo.svg');
    const b = loadMark('/foo.svg');
    expect(a).toBe(b);
  });

  it('only fetches once for repeated calls with the same src', async () => {
    await Promise.all([loadMark('/foo.svg'), loadMark('/foo.svg'), loadMark('/foo.svg')]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('returns different Promises for different srcs', () => {
    const a = loadMark('/a.svg');
    const b = loadMark('/b.svg');
    expect(a).not.toBe(b);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('parses and normalizes the SVG into a Mark', async () => {
    const m = await loadMark('/foo.svg');
    expect(m.paths).toHaveLength(1);
    expect(m.paths[0]!.segments.length).toBeGreaterThan(0);
  });

  it('rejects with an informative error on non-ok HTTP', async () => {
    fetchSpy.mockResolvedValueOnce(errResponse(404, 'Not Found'));
    await expect(loadMark('/missing.svg')).rejects.toThrow(/failed to fetch.*404.*Not Found/);
  });

  it('evicts failed entries so the next call retries the fetch', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('network'));
    await expect(loadMark('/flaky.svg')).rejects.toThrow('network');

    fetchSpy.mockResolvedValueOnce(okResponse(SVG));
    const m = await loadMark('/flaky.svg');
    expect(m.paths.length).toBeGreaterThan(0);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('also evicts on non-ok HTTP responses', async () => {
    fetchSpy.mockResolvedValueOnce(errResponse(500, 'Server Error'));
    await expect(loadMark('/bad.svg')).rejects.toThrow();

    fetchSpy.mockResolvedValueOnce(okResponse(SVG));
    await loadMark('/bad.svg');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('clearSvgCache forces a refetch', async () => {
    await loadMark('/foo.svg');
    clearSvgCache();
    await loadMark('/foo.svg');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
