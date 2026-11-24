import { StatusRequestRow, ThreadNotification } from '../../repositories/followup';

/**
 * سلاسل ردود الإشعارات — `notifications::replyThreads()` وأخواتها في الويب.
 *
 * الردُّ الحديث يحمل `parent_id`. الردودُ القديمة بلا رابط، فتُنسب إلى **أقرب
 * إشعارٍ سبقها** عنوانُه عنوانُ الرد بلا «رد على: »/«رد عميل: » — لنفس العميل،
 * أو بين الطرفين أنفسهما. منسوخةٌ خطوةً بخطوة كي لا تفترق النتيجة عن الويب.
 */

export const REPLY_TITLE_PREFIXES = ['رد على: ', 'رد عميل: '];
export const STATUS_REQUEST_TYPES = ['client_status_request', 'client_status_approved', 'client_status_rejected'];

const clippedEnd = /(\.\.\.|…)\s*$/u;
const length = (s: string) => [...s].length;

/** العنوان موحَّد المسافات وبلا «...» في آخره — `replyTitleKey()` */
export function replyTitleKey(title: string): string {
  return title.trim().replace(/\s+/gu, ' ').replace(clippedEnd, '').trim();
}

/** `replyTitleMatches()` — مساواةً، أو بادئةً حين قُصّ أحدهما */
export function replyTitleMatches(replyTitle: string, originalTitle: string): boolean {
  const reply = replyTitleKey(replyTitle);
  const original = replyTitleKey(originalTitle);
  if (reply === '' || original === '') return false;
  if (reply === original) return true;
  const clipped = (t: string) => clippedEnd.test(t) || length(t) >= 240;
  return (clipped(originalTitle) && reply.startsWith(original)) || (clipped(replyTitle) && original.startsWith(reply));
}

/** `replyDescriptionMatches()` — مساواةً أو بادئةً من 12 حرفاً فأكثر */
export function replyDescriptionMatches(replyTitle: string, description: string): boolean {
  const reply = replyTitleKey(replyTitle);
  const text = replyTitleKey(description.replace(/<[^>]*>/g, ''));
  return reply !== '' && text !== '' && (reply === text || (length(reply) >= 12 && text.startsWith(reply)));
}

const pair = (a: number | null, b: number | null) => [Number(a ?? 0), Number(b ?? 0)].sort((x, y) => x - y).join('-');

/** `date('Y-m-d H:i:s', strtotime($at) - 86400)` على وقتٍ ساذج */
function dayBefore(at: string | null): string {
  const d = new Date(`${(at ?? '1970-01-01 00:00:00').replace(' ', 'T')}Z`);
  d.setUTCSeconds(d.getUTCSeconds() - 86400);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/** الردود القديمة (بلا رابط) مع عنوان الأصل المستخرج — ومعاملات جلب المرشَّحين */
export function legacyReplies(replies: ThreadNotification[]) {
  const linked = new Map<number, number[]>();
  const legacy: Array<[ThreadNotification, string]> = [];

  for (const reply of replies) {
    if (reply.parentId) {
      const list = linked.get(reply.parentId) ?? [];
      list.push(reply.id);
      linked.set(reply.parentId, list);
      continue;
    }
    const title = reply.title ?? '';
    const prefix = REPLY_TITLE_PREFIXES.find((p) => title.startsWith(p));
    if (prefix) legacy.push([reply, [...title].slice([...prefix].length).join('')]);
  }

  const loose = legacy.map(([r]) => r).filter((r) => r.clientId === null);
  return {
    linked,
    legacy,
    candidates: {
      clientIds: [...new Set(legacy.map(([r]) => r.clientId).filter((v): v is number => v !== null))],
      titles: [...new Set(legacy.map(([, t]) => t))],
      repliers: [...new Set(loose.map((r) => Number(r.userId ?? 0)))],
      addressees: [...new Set(loose.map((r) => Number(r.receiverId ?? 0)))],
    },
  };
}

/** `replyThreads()` — `[الأصل => [ردوده]]` */
export function replyThreads(replies: ThreadNotification[], originals: ThreadNotification[]): Map<number, number[]> {
  const { linked, legacy } = legacyReplies(replies);
  const threads = new Map<number, number[]>(linked);
  const push = (id: number, replyId: number) => threads.set(id, [...(threads.get(id) ?? []), replyId]);

  if (legacy.length) {
    const byClient = new Map<number, ThreadNotification[]>();
    const byTitle = new Map<string, ThreadNotification[]>();
    const byPeople = new Map<string, ThreadNotification[]>();
    for (const o of originals) {
      if (o.clientId !== null) byClient.set(o.clientId, [...(byClient.get(o.clientId) ?? []), o]);
      byTitle.set(o.title ?? '', [...(byTitle.get(o.title ?? '') ?? []), o]);
      if (o.receiverId !== null) {
        const key = pair(o.userId, o.receiverId);
        byPeople.set(key, [...(byPeople.get(key) ?? []), o]);
      }
    }

    const lastReplyAt = new Map<string, string>();
    const at = (s: string | null) => s ?? '';

    for (const [reply, title] of legacy) {
      let pool: ThreadNotification[];
      if (reply.clientId !== null) {
        pool = byClient.get(reply.clientId) ?? [];
      } else {
        const seen = new Set<number>();
        pool = [...(byTitle.get(title) ?? []), ...(byPeople.get(pair(reply.userId, reply.receiverId)) ?? [])]
          .filter((o) => (seen.has(o.id) ? false : (seen.add(o.id), true)))
          .sort((a, b) => (at(a.createdAt) < at(b.createdAt) ? 1 : at(a.createdAt) > at(b.createdAt) ? -1 : b.id - a.id));
      }

      // الأحدثُ أوّلاً — فأوّلُ مطابِقٍ هو أقربُ إشعارٍ سبق الرد
      const matches: Array<[number, ThreadNotification]> = [];
      for (const original of pool) {
        const titleHit = replyTitleMatches(title, original.title ?? '');
        if (at(original.createdAt) > at(reply.createdAt) || !(titleHit || replyDescriptionMatches(title, original.description ?? ''))) continue;

        if (reply.clientId === null) {
          const samePeople = original.receiverId === null ? Number(reply.receiverId ?? 0) === Number(original.userId ?? 0) : pair(original.userId, original.receiverId) === pair(reply.userId, reply.receiverId);
          if (!samePeople) continue;
        }

        matches.push([(titleHit ? 2 : 0) + (Number(original.receiverId ?? 0) === Number(reply.userId ?? 0) ? 1 : 0), original]);
      }
      if (!matches.length) continue;

      const best = Math.max(...matches.map(([score]) => score));
      const candidates = matches.filter(([score]) => score === best);
      const nearest = candidates[0][1];

      // الإشعارُ المكرَّر خلال اليوم الذي سبق أقربَه يُجاب عنه كلُّه
      const key = `${reply.clientId ?? `u${pair(reply.userId, reply.receiverId)}`}|${replyTitleKey(nearest.title ?? '')}`;
      const previous = lastReplyAt.get(key) ?? '';
      const floor = dayBefore(nearest.createdAt);
      const since = previous > floor ? previous : floor;

      for (const [, original] of candidates) {
        if (original !== nearest && (at(original.createdAt) <= since || replyTitleKey(original.title ?? '') !== replyTitleKey(nearest.title ?? ''))) continue;
        push(original.id, reply.id);
      }
      lastReplyAt.set(key, at(reply.createdAt));
    }
  }

  for (const [id, ids] of threads) threads.set(id, [...new Set(ids)].sort((a, b) => a - b));
  return threads;
}

export interface Decision {
  text: string;
  byId: number | null;
  byName: string | null;
  at: string | null;
}

const minuteOf = (s: string | null) => (s ? s.slice(0, 16) : null);
const epoch = (s: string | null) => (s ? Date.parse(`${s.replace(' ', 'T')}Z`) / 1000 : 0);

/**
 * `statusDecisionReplies()[id]` لإشعارٍ واحد — ردُّ «طلب اعتماد حالة» قرارُ
 * الاعتماد أو الرفض: أقرب طلبٍ في وقت الإشعار لنفس العميل ومن نفس الطالب.
 */
export function statusDecisionFor(
  note: { id: number; type: string | null; userId: number | null; clientId: number | null; createdAt: string | null },
  requests: StatusRequestRow[],
  statusNames: Map<number, string>,
  userNames: Map<number, string>,
): Decision | null {
  if (note.type === 'client_status_approved' || note.type === 'client_status_rejected') {
    return {
      text: note.type === 'client_status_approved' ? 'قرار: تم اعتماد الطلب' : 'قرار: تم رفض الطلب',
      byId: note.userId ?? null,
      byName: note.userId ? userNames.get(note.userId) ?? null : null,
      at: minuteOf(note.createdAt),
    };
  }
  if (note.type !== 'client_status_request') return null;

  const noteAt = epoch(note.createdAt);
  let best: [number, StatusRequestRow] | null = null;
  for (const r of requests.filter((x) => x.requestedBy === Number(note.userId ?? 0))) {
    const gap = Math.abs(epoch(r.createdAt) - noteAt);
    if (best === null || gap < best[0]) best = [gap, r];
  }
  if (!best) return null;

  let request = best[1];
  let superseded = false;
  if (!['approved', 'rejected'].includes(request.status ?? '')) {
    const later = requests.find((r) => ['approved', 'rejected'].includes(r.status ?? '') && r.id > request.id);
    if (!later) return null;
    request = later;
    superseded = true;
  }

  const name = (id: number | null) => (id ? statusNames.get(id) : undefined) ?? '—';
  const text = request.status === 'approved' ? `تم اعتماد الطلب: من «${name(request.oldStatusId)}» إلى «${name(request.newStatusId)}»` : `تم رفض الطلب (${name(request.newStatusId)})`;

  return {
    text: `${superseded ? 'حُسم بطلبٍ لاحق — ' : ''}${text}${request.notes ? ` — ${request.notes}` : ''}`,
    byId: request.approvedBy,
    byName: request.approvedBy ? userNames.get(request.approvedBy) ?? null : null,
    at: minuteOf(request.updatedAt),
  };
}
