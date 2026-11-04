import { describe, expect, it } from 'vitest';
import type { FieldPhoto } from '@harvest/contracts';
import { photoAt } from './FieldImage';
const photo = (id: string, capturedOn: string): FieldPhoto => ({id, capturedOn, mediaId: id, imagePath: '/api/v1/media/test/content', createdAt: `${capturedOn}T12:00:00Z`});
describe('field image timeline', () => {
  const photos = [photo('late', '2026-10-20'), photo('early', '2026-10-01')];
  it('uses the latest photo on or before the selected date, independent of upload order', () => {
    expect(photoAt(photos, '2026-10-19')?.id).toBe('early');
    expect(photoAt(photos, '2026-10-20')?.id).toBe('late');
    expect(photoAt(photos, '2026-11-01')?.id).toBe('late');
  });
  it('does not pass off a later photo as a past observation', () => {
    expect(photoAt(photos, '2026-09-30')).toBeNull();
    expect(photoAt([], '2026-10-01')).toBeNull();
  });
});
