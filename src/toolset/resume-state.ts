import { createHash } from 'node:crypto';
import type { Page } from 'puppeteer-core';
import type { BossChatIdentity } from './chat-identity.js';

/** 仅比较简历正文模块，排除临时身份、活跃时间和展示高亮。 */
export function resumeContentFingerprint(detail: Record<string, any>): string {
  const base = detail.geekBaseInfo || {};
  const profile = Object.fromEntries(['name','gender','degree','workYears','workYearDesc','age','userDescription','advantages']
    .filter(k => base[k] != null).map(k => [k, base[k]]));
  const sections = ['geekExpPosList','geekWorkExpList','geekProjExpList','geekEduExpList','geekTrainingExpList',
    'geekVolunteerExpList','geekCertificationList','geekHonorList','professionalSkill','geekSocialContactList'];
  const content = { profile, ...Object.fromEntries(sections.filter(k => detail[k] != null).map(k => [k, detail[k]])) };
  function clean(value: any): any {
    if (Array.isArray(value)) return value.map(clean);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort()
      .filter(k => !/^(id|geekId|expectId|addTime|updateTime|securityId|lid|suid|enc.*|encrypt.*)$/.test(k) && !/highlight/i.test(k))
      .map(k => [k, clean(value[k])]));
  }
  return createHash('sha256').update(JSON.stringify(clean(content))).digest('hex');
}

export async function readOnlineResumeState(page: Page, identity: BossChatIdentity) {
  // 好友详情提供当前 securityId；这里只读取正文，不截图、不下载、不发送消息。
  const params = new URLSearchParams({ securityId: identity.securityId, encryptJid: identity.encryptJobId,
    expectId: identity.expectId || '', sourceType: '1', wayType: '0' });
  const data = await page.evaluate(`(async () => {
    const response=await fetch('/wapi/zpjob/view/geek/info?'+${JSON.stringify(params.toString())},
      {credentials:'include',signal:AbortSignal.timeout(15000)});
    return await response.json();
  })()`) as { code?: number; message?: string; zpData?: { geekDetailInfo?: Record<string, any>; msg?: string } };
  const detail = data?.zpData?.geekDetailInfo;
  if (data?.code !== 0 || !detail?.geekBaseInfo || !Object.keys(detail.geekBaseInfo).length) {
    throw new Error(`无法检查在线简历正文：${data?.message || data?.zpData?.msg || '平台未返回完整简历'}`);
  }
  return { fingerprint: resumeContentFingerprint(detail), checkedAt: new Date().toISOString() };
}

export async function readAttachmentStates(page: Page) {
  return page.evaluate(`(() => {
    const result=[];const seen=new Set();
    for(const node of document.querySelectorAll('.chat-message-list .message-item, .chat-message-list .message-item *')) {
      let vm=node.__vue__;
      for(let n=0;vm&&n<5;n++,vm=vm.$parent){
        const m=vm.message;const link=m?.hyperLink;
        if(!m||!link||!link.url||m.isSelf||!vm.previewText?.includes('附件简历'))continue;
        const url=new URL(link.url,location.origin);const attachmentId=url.searchParams.get('encryptId')||url.searchParams.get('id');
        if(!attachmentId||seen.has(attachmentId))continue;
        seen.add(attachmentId);result.push({attachmentId,messageId:String(m.mid||''),sentAt:m.time||null});
      }
    }
    return result;
  })()`) as Promise<Array<{ attachmentId: string; messageId: string; sentAt: number | null }>>;
}
