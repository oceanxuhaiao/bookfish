import { randomUUID } from 'node:crypto';
import { requiredText } from './books.ts';

/** One spoken chat bubble. Keep desktop replies short rather than a panel essay. */
export const DISCUSSION_SEGMENT_LIMIT = 60;
export const DISCUSSION_SEGMENT_COUNT = 8;

export type DiscussionDelivery = 'spoken' | 'unavailable';

/** Gap after a bubble has finished before the next bubble starts. */
export const DISCUSSION_BUBBLE_GAP_MS = 2500;

/** pet_say uses 【emotion】 / <action> markers; the panel keeps only spoken words. */
export function discussionSpokenText(value: string): string {
  return value.replace(/【[^】]{1,40}】/gu, '').replace(/<[^>]{1,40}>/gu, '').trim();
}

/**
 * How long to wait after one spoken bubble before starting the next.
 * The formula mirrors the desktop pet's estimate at its default speed:
 * typing ~20 chars/s + 1.6s hold + 0.07s per character, then a 2.5s gap.
 */
export function discussionPauseMs(chars: number): number {
  const count = Math.max(0, Math.min(200, Math.floor(chars)));
  const bubbleMs = Math.round((count / 20 + 1.6 + count * 0.07) * 1000);
  return Math.max(3000, Math.min(12000, bubbleMs + DISCUSSION_BUBBLE_GAP_MS));
}

interface DiscussionItem {
  id: string;
  bookKey: string;
  episodeId: string;
  question: string;
  createdAt: number;
  segments: string[];
  delivery: DiscussionDelivery | null;
  reason: string | null;
}

/** Short-lived UI replies only; the host owns the actual model conversation. */
export class Discussions {
  private items: DiscussionItem[] = [];

  create(bookKey: string, episodeId: string, question: unknown) {
    this.items = this.items.filter((item) => item.createdAt + 1800000 > Date.now());
    if (this.items.length >= 20) throw new Error('Discussion panel full; wait for older requests to expire');
    const item: DiscussionItem = {
      id: randomUUID(),
      bookKey,
      episodeId,
      question: requiredText(question, 'text', 2000),
      createdAt: Date.now(),
      segments: [],
      delivery: null,
      reason: null,
    };
    this.items.push(item);
    return this.view(item);
  }

  cancel(id: string) {
    this.items = this.items.filter((item) => item.id !== id);
  }

  reply(args: Record<string, unknown>) {
    const id = requiredText(args.discussionId, 'discussionId', 80);
    const item = this.items.find((entry) => entry.id === id);
    if (!item || item.createdAt + 1800000 <= Date.now()) throw new Error('Discussion expired or not found');
    const delivery = args.delivery;
    if (delivery !== 'spoken' && delivery !== 'unavailable') throw new Error('delivery must be spoken or unavailable');

    if (delivery === 'spoken') {
      if (!Array.isArray(args.segments) || args.segments.length < 1 || args.segments.length > DISCUSSION_SEGMENT_COUNT) {
        throw new Error(`Spoken reply needs 1-${DISCUSSION_SEGMENT_COUNT} segments`);
      }
      const segments = args.segments.map((value, index) => {
        if (typeof value !== 'string') throw new Error(`Discussion segment ${index + 1} is invalid`);
        const segment = discussionSpokenText(value);
        if (!segment) throw new Error(`Discussion segment ${index + 1} is empty`);
        if (Array.from(segment).length > DISCUSSION_SEGMENT_LIMIT) {
          throw new Error(`Discussion segment ${index + 1} exceeds ${DISCUSSION_SEGMENT_LIMIT} code points`);
        }
        return segment;
      });
      if (segments.reduce((total, segment) => total + Array.from(segment).length, 0) > 300) {
        throw new Error('Discussion reply is too long');
      }
      return this.save(item, { delivery, segments, reason: null });
    }

    if (args.segments !== undefined && (!Array.isArray(args.segments) || args.segments.length > 0)) {
      throw new Error('Unavailable reply must not contain spoken segments');
    }
    const reason = args.reason === undefined ? null : requiredText(args.reason, 'reason', 300);
    return this.save(item, { delivery, segments: [], reason });
  }

  list() {
    return this.items.map((item) => this.view(item));
  }

  removeBook(key: string) {
    this.items = this.items.filter((item) => item.bookKey !== key);
  }

  clear() {
    this.items = [];
  }

  private view(item: DiscussionItem) {
    return {
      ...item,
      segments: [...item.segments],
      expired: item.createdAt + 1800000 <= Date.now(),
    };
  }

  private save(item: DiscussionItem, next: { delivery: DiscussionDelivery; segments: string[]; reason: string | null }) {
    if (item.delivery !== null) {
      const same = item.delivery === next.delivery &&
        item.reason === next.reason &&
        JSON.stringify(item.segments) === JSON.stringify(next.segments);
      if (!same) throw new Error('Reply already saved; do not overwrite');
    } else {
      item.delivery = next.delivery;
      item.segments = next.segments;
      item.reason = next.reason;
    }
    return { saved: true, discussionId: item.id, delivery: item.delivery, segments: [...item.segments] };
  }
}
