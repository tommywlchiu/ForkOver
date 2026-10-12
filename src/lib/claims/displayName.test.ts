import { personDisplayName } from './displayName';

describe('personDisplayName', () => {
  it('labels the viewer\'s own row "(you)", even when the viewer is the payer', () => {
    expect(personDisplayName({ name: 'Alex', personId: 'a', payerId: 'a', viewerPersonId: 'a' })).toBe('Alex (you)');
  });

  it('labels the payer\'s row "(payer)" for a non-payer viewer', () => {
    expect(personDisplayName({ name: 'Alex', personId: 'a', payerId: 'a', viewerPersonId: 'b' })).toBe('Alex (payer)');
  });

  it('labels a non-payer, non-viewer row with the bare name', () => {
    expect(personDisplayName({ name: 'Cate', personId: 'c', payerId: 'a', viewerPersonId: 'b' })).toBe('Cate');
  });

  it('prefers "(you)" over "(payer)" when the viewer is the payer themselves', () => {
    expect(personDisplayName({ name: 'Alex', personId: 'a', payerId: 'a', viewerPersonId: 'a' })).not.toContain('(payer)');
  });
});
