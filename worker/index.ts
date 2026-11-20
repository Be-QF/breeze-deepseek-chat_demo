/**
 * Cloudflare Worker 入口：静态资源 + DeepSeek 分享接口代理。
 *
 * chat.deepseek.com 不返回 CORS 头，静态站点无法直接从浏览器读取分享内容；
 * 这里用同源 Worker 转发 /api/v0/share/content?share_id=xxx，其余请求回落到静态资源。
 */

const SHARE_ID = /^[^/?#\s]{4,128}$/

type AssetsBinding = { fetch: (request: Request) => Promise<Response> }
type Env = { ASSETS: AssetsBinding }

const fail = (status: number, message: string): Response =>
  Response.json({ data: { biz_code: -1, biz_msg: message, biz_data: null } }, { status })

const proxyShareContent = async (request: Request): Promise<Response> => {
  const shareId = new URL(request.url).searchParams.get('share_id')
  if (!shareId || !SHARE_ID.test(shareId)) {
    return Response.json(
      { data: { biz_code: 1, biz_msg: 'invalid share id', biz_data: null } },
      { status: 400 }
    )
  }
  try {
    const upstream = await fetch(
      `https://chat.deepseek.com/api/v0/share/content?share_id=${encodeURIComponent(shareId)}`,
      {
        headers: {
          Accept: 'application/json',
          Referer: `https://chat.deepseek.com/a/chat/s/${shareId}`,
        },
      }
    )
    if (!upstream.ok) {
      return fail(502, 'upstream failed')
    }
    return new Response(await upstream.text(), {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      },
    })
  } catch {
    return fail(502, 'upstream unavailable')
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url)
    if (pathname === '/api/v0/share/content') {
      return proxyShareContent(request)
    }
    return env.ASSETS.fetch(request)
  },
}
