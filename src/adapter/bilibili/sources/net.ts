/**
 * URL 弹幕源的网络访问。用 GM_xmlhttpRequest 绕过跨域限制，
 * 比 fetch 更可靠（B 站和巴哈姆特都不需要 Cookie）。
 */
export interface NetResult {
  status: number
  response: any
}

function toUrl(url: string, params?: Record<string, string | number>) {
  if (!params) return url
  const u = new URL(url)
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null) u.searchParams.set(key, String(value))
  })
  return u.toString()
}

function send<T>(
  opts: {
    url: string
    method?: 'GET' | 'POST'
    params?: Record<string, string | number>
    data?: string
    headers?: Record<string, string>
    responseType?: 'json' | 'arraybuffer' | 'text'
    timeout?: number
  }
): Promise<T> {
  return new Promise((resolve, reject) => {
    const url = toUrl(opts.url, opts.params)
    GM_xmlhttpRequest({
      url,
      method: opts.method || 'GET',
      data: opts.data,
      headers: opts.headers,
      responseType: (opts.responseType || 'json') as any,
      timeout: opts.timeout ?? 15000,
      onload: (res) => {
        if (res.status < 200 || res.status >= 400) {
          reject(new Error(`HTTP ${res.status} ${url}`))
          return
        }
        resolve(res.response as T)
      },
      onerror: () => reject(new Error(`网络错误 ${url}`)),
      ontimeout: () => reject(new Error(`请求超时 ${url}`)),
    })
  })
}

export function getJson<T>(url: string, params?: Record<string, string | number>) {
  return send<T>({ url, params, responseType: 'json' })
}

export function getBytes(url: string, params?: Record<string, string | number>) {
  return new Promise<{ status: number; bytes: Uint8Array | null }>((resolve, reject) => {
    const full = toUrl(url, params)
    GM_xmlhttpRequest({
      url: full,
      method: 'GET',
      responseType: 'arraybuffer',
      timeout: 15000,
      onload: (res) => {
        // B 站对没有弹幕的分段回 304，这是“到此为止”的信号而不是错误
        if (res.status === 304) {
          resolve({ status: 304, bytes: null })
          return
        }
        if (res.status < 200 || res.status >= 400) {
          reject(new Error(`HTTP ${res.status} ${full}`))
          return
        }
        resolve({ status: res.status, bytes: new Uint8Array(res.response || []) })
      },
      onerror: () => reject(new Error(`网络错误 ${full}`)),
      ontimeout: () => reject(new Error(`请求超时 ${full}`)),
    })
  })
}

export function postJson<T>(
  url: string,
  body: string,
  headers?: Record<string, string>
) {
  return new Promise<{ status: number; response: T }>((resolve, reject) => {
    GM_xmlhttpRequest({
      url,
      method: 'POST',
      data: body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
      responseType: 'json',
      timeout: 15000,
      onload: (res) => {
        if (res.status < 200 || res.status >= 400) {
          reject(new Error(`HTTP ${res.status} ${url}`))
          return
        }
        resolve({ status: res.status, response: res.response as T })
      },
      onerror: () => reject(new Error(`网络错误 ${url}`)),
      ontimeout: () => reject(new Error(`请求超时 ${url}`)),
    })
  })
}
