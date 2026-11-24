import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { matchConversationsByName, normalizeName } from '../src/actions/resolve.js';
import { parseLinkedInFrame, extractMessageFromEvent } from '../src/parse/frame.js';

describe('normalizeName', () => {
  it('strips punctuation', () => {
    assert.equal(normalizeName('Jane A. Doe'), 'jane a doe');
  });
});

describe('matchConversationsByName', () => {
  const convos = [
    {
      conversationUrn: 'urn:li:msg_conversation:(x,2-jane=)',
      participants: [
        { name: 'Example User', profileUrn: '', headline: '' },
        { name: 'Jane Doe', profileUrn: '', headline: '' },
      ],
      lastActivityAt: null,
      createdAt: null,
      unreadCount: 0,
      read: true,
      title: '',
      lastMessagePreview: '',
      messages: [],
    },
    {
      conversationUrn: 'urn:li:msg_conversation:(x,2-jane2=)',
      participants: [
        { name: 'Example User', profileUrn: '', headline: '' },
        { name: 'Jane A. Doe', profileUrn: '', headline: '' },
      ],
      lastActivityAt: null,
      createdAt: null,
      unreadCount: 0,
      read: true,
      title: '',
      lastMessagePreview: '',
      messages: [],
    },
  ];

  it('returns one match for unique name', () => {
    const m = matchConversationsByName(convos.slice(0, 1), 'Jane Doe', { selfName: 'Example User' });
    assert.equal(m.length, 1);
  });

  it('returns multiple for ambiguous', () => {
    const m = matchConversationsByName(convos, 'Jane Doe', { selfName: 'Example User' });
    assert.equal(m.length, 2);
  });
});

describe('frame parser', () => {
  it('parses messaging realtime frame', () => {
    const frame = JSON.stringify({
      topic: '/messaging/realtime',
      body: { text: 'hello there friend' },
      actor: { firstName: { text: 'Jane' }, lastName: { text: 'Doe' } },
      deliveredAt: 1700000000000,
    });
    const parsed = parseLinkedInFrame(frame);
    assert.equal(parsed?.text, 'hello there friend');
    assert.equal(parsed?.sender, 'Jane Doe');
  });

  it('rejects short bodies', () => {
    assert.equal(extractMessageFromEvent({ body: { text: 'x' } }), null);
  });
});