import 'dotenv/config'
import WebSocket from "ws"
import { chat_with_content, gen_img, get_discrption_from_img } from "./get_img.js"
import { join, relative, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"

const token = process.env.NAPCAT_TOKEN || ''
const NAPCAT_WS_URL = process.env.NAPCAT_WS_URL || 'ws://127.0.0.1:3001'
const WHITELIST = JSON.parse(process.env.WHITELIST || '[]')
let self_qq_id = -999
const DEBUG = process.env.DEBUG === '1'
const BOT_DISPLAY_NAME = process.env.BOT_DISPLAY_NAME || 'AI Bot'
const HOST_OUTPUT_DIR = resolve(process.env.OUTPUT_DIR || 'output')
const NAPCAT_MOUNT_OUTPUT_DIR = process.env.NAPCAT_MOUNT_OUTPUT_DIR || HOST_OUTPUT_DIR
const ws = new WebSocket(NAPCAT_WS_URL, {
    headers: {
        Authorization: `Bearer ${token}`
    },
})
const pendingMap = new Map()
const connectStartedAt = Date.now()

function maskToken(value) {
    if (!value) return '(empty)'
    if (value.length <= 4) return '*'.repeat(value.length)
    return `${value.slice(0, 2)}***${value.slice(-2)}`
}

function sanitizeHeaders(headers = {}) {
    return Object.fromEntries(
        Object.entries(headers).map(([key, value]) => {
            if (String(key).toLowerCase() === 'authorization') {
                return [key, String(value).replace(/Bearer\s+(.+)/i, (_, tokenValue) => `Bearer ${maskToken(tokenValue)}`)]
            }
            return [key, value]
        })
    )
}

function describeReadyState(readyState) {
    return ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'][readyState] || `UNKNOWN(${readyState})`
}

function logInfo(...args) {
    console.log('[napcat]', ...args)
}

function logWarn(...args) {
    console.warn('[napcat]', ...args)
}

function logError(...args) {
    console.error('[napcat]', ...args)
}

function logDebug(...args) {
    if (DEBUG) {
        console.log('[napcat:debug]', ...args)
    }
}

function formatTaskError(err, maxLength = 220) {
    const rawMessage = err?.message || String(err || '未知错误')
    const compactMessage = rawMessage.replace(/\s+/g, ' ').trim()

    if (compactMessage.length <= maxLength) {
        return compactMessage
    }

    return `${compactMessage.slice(0, maxLength)}...`
}

function stripResolutionFlags(text) {
    return String(text || '')
        .replace(/^#画图\s*/i, '')
        .replace(/\b3k_[hv]\b/ig, '')
        .replace(/\s+/g, ' ')
        .trim()
}

function toNapcatFileUrl(localPath) {
    const absoluteLocalPath = resolve(localPath)
    let napcatPath = absoluteLocalPath

    if (
        absoluteLocalPath === HOST_OUTPUT_DIR ||
        absoluteLocalPath.startsWith(`${HOST_OUTPUT_DIR}${sep}`)
    ) {
        const relativePath = relative(HOST_OUTPUT_DIR, absoluteLocalPath).split(sep).join('/')
        const mountBase = String(NAPCAT_MOUNT_OUTPUT_DIR || '').replace(/\\/g, '/').replace(/\/$/, '')
        napcatPath = relativePath ? `${mountBase}/${relativePath}` : mountBase
    }

    if (String(napcatPath).startsWith('/')) {
        return `file://${napcatPath}`
    }

    return pathToFileURL(napcatPath).href
}

class user_queue {
    constructor(maxsize = 5) {
        this.queue = []
        this.maxsize = maxsize
    }

    mypush(task) {
        logDebug('queue before push', this.queue)
        if (this.queue.length >= this.maxsize) return 'FAIL! queue is full!'
        this.queue.push(task)
        return `排队中。当前在第${this.queue.length}位。生图时间较长，耐心等待喵～`
    }

    mypop() {
        if (this.queue.length === 0) return
        return this.queue.shift()
    }
}

function sendGroupMsg(ws, groupId, message, user_id = 'none', echo = `send_group_msg_${Date.now()}`, use_forward = false) {
    logDebug('send group message', { groupId, user_id, echo, use_forward })
    if (!use_forward) {
        ws.send(JSON.stringify({
            action: 'send_group_msg',
            params: {
                group_id: groupId,
                message: [
                    user_id ? {
                        type: 'at',
                        data: {
                            qq: String(user_id)
                        }
                    } : null,
                    {
                        type: 'text',
                        data: {
                            text: `\r\n${message}`
                        }
                    }
                ].filter(Boolean)
            },
            echo
        }))
        return
    }

    ws.send(JSON.stringify({
        action: 'send_group_forward_msg',
        params: {
            group_id: groupId,
            message: {
                type: 'node',
                data: {
                    user_id: String(self_qq_id),
                    nickname: BOT_DISPLAY_NAME,
                    content: [
                        {
                            type: 'at',
                            data: {
                                qq: String(user_id)
                            }
                        },
                        {
                            type: 'text',
                            data: {
                                text: message
                            }
                        }
                    ]
                }
            }
        },
        echo
    }))
}

function get_msg_byID(ws, id) {
    return new Promise((resolve, reject) => {
        const echo = `get_msg_${id}_${Date.now()}`
        pendingMap.set(echo, { resolve, reject })
        ws.send(JSON.stringify({
            action: 'get_msg',
            params: {
                message_id: String(id)
            },
            echo
        }))
    })
}

function send_group_img(ws, groupId, user_id, img_path, user_text, resolution) {
    const fileUrl = toNapcatFileUrl(img_path)
    const echo = `send_group_img_${Date.now()}`
    const payload = {
        action: 'send_group_msg',
        params: {
            group_id: groupId,
            message: [
                {
                    type: 'at',
                    data: {
                        qq: String(user_id)
                    }
                },
                {
                    type: 'text',
                    data: {
                        text: `\r\n你请求的 ${user_text} 生成好了喵！`
                    }
                },
                {
                    type: 'image',
                    data: {
                        file: fileUrl,
                    }
                },
                ...(resolution === 'auto' ? [{
                    type: 'text',
                    data: {
                        text: '\r\nhint: 如果想生成高分辨率图片，可以在文本最后添加 3k_h(3k 横向图片) 或者 3k_v(3k 纵向图片)'
                    }
                }] : [])
            ]
        },
        echo,
    }

    logInfo('send image message', {
        groupId,
        userId: user_id,
        echo,
        img_path,
        fileUrl,
    })
    logDebug('send image payload', payload)
    ws.send(JSON.stringify(payload))
}

const userQueue = new user_queue()

logInfo('connecting to NapCat websocket', {
    url: NAPCAT_WS_URL,
    token: maskToken(token),
    readyState: describeReadyState(ws.readyState),
    whitelistSize: WHITELIST.length,
    hostOutputDir: HOST_OUTPUT_DIR,
    napcatMountOutputDir: NAPCAT_MOUNT_OUTPUT_DIR,
})

ws.on('open', () => {
    logInfo('websocket connected', {
        url: NAPCAT_WS_URL,
        elapsedMs: Date.now() - connectStartedAt,
        readyState: describeReadyState(ws.readyState),
    })
    ws.send(JSON.stringify({
        action: 'get_login_info'
    }))
})

ws.on('unexpected-response', (_, response) => {
    logError('websocket handshake rejected', {
        url: NAPCAT_WS_URL,
        statusCode: response.statusCode,
        statusMessage: response.statusMessage,
        headers: sanitizeHeaders(response.headers),
    })
})

ws.on('error', (err) => {
    logError('websocket error', {
        url: NAPCAT_WS_URL,
        readyState: describeReadyState(ws.readyState),
        message: err?.message,
        code: err?.code,
        errno: err?.errno,
        syscall: err?.syscall,
        address: err?.address,
        port: err?.port,
        stack: err?.stack,
    })
})

ws.on('close', (code, reasonBuffer) => {
    const reason = Buffer.isBuffer(reasonBuffer) ? reasonBuffer.toString() : String(reasonBuffer || '')
    logWarn('websocket closed', {
        url: NAPCAT_WS_URL,
        code,
        reason,
        readyState: describeReadyState(ws.readyState),
        elapsedMs: Date.now() - connectStartedAt,
    })
})

if (ws._socket) {
    ws._socket.on('error', (err) => {
        logError('underlying socket error', {
            url: NAPCAT_WS_URL,
            message: err?.message,
            code: err?.code,
            errno: err?.errno,
            syscall: err?.syscall,
            address: err?.address,
            port: err?.port,
        })
    })
}

let generation = false

function process_queue(ws, task) {
    logInfo('queue task received', {
        groupId: task.group_id,
        userId: task.user_id,
        prompt: task.data,
        resolution: task.resolution,
        edit: Boolean(task.edit),
        hasImageReference: Boolean(task.img_url),
        img_url: task.img_url || '',
    })
    const queue_res = userQueue.mypush(task)
    sendGroupMsg(ws, task.group_id, queue_res, task.user_id)
    if (!generation) {
        processQueue(ws)
    }
}

async function processQueue(ws) {
    if (generation) return
    generation = true

    try {
        while (userQueue.queue.length > 0) {
            const task = userQueue.mypop()
            try {
                logInfo('start image task', {
                    groupId: task.group_id,
                    userId: task.user_id,
                    prompt: task.data,
                    resolution: task.resolution,
                    edit: Boolean(task.edit),
                    hasImageReference: Boolean(task.img_url),
                    img_url: task.img_url || '',
                })
                const result = await gen_img(task.data, task.resolution, task.edit, task.img_url)
                if (result.startsWith('[ERROR]')) {
                    sendGroupMsg(ws, task.group_id, result, task.user_id)
                }
                else {
                    send_group_img(ws, task.group_id, task.user_id, result, task.data, task.resolution)
                }
                logInfo('image task finished', { output: result })
            } catch (err) {
                logError('image task failed', err)
                sendGroupMsg(
                    ws,
                    task.group_id,
                    `生图失败了喵：${formatTaskError(err)}`,
                    task.user_id,
                )
            }
        }
    } catch (err) {
        logError('queue processing failed', err)
    } finally {
        generation = false
    }
}

async function put_img_in_queue(ws, msg_data, cur_reply_msg_id, data, reply_msg = false, edit_msg = false) {
    const trimed_msg_data = msg_data.data.text.trim()
    const lower_msg_data = trimed_msg_data.toLowerCase()
    const cleaned_prompt = stripResolutionFlags(trimed_msg_data)
    let resolution = 'auto'
    if (lower_msg_data.includes('3k_v')) resolution = '1728x3072'
    else if (lower_msg_data.includes('3k_h')) resolution = '3072x1728'

    if (reply_msg) {
        const promise_data = await get_msg_byID(ws, cur_reply_msg_id)
        logDebug('reply target fetched', promise_data)
        logInfo('reply image task request', {
            groupId: data.group_id,
            userId: data.user_id,
            replyId: cur_reply_msg_id,
            raw_text: trimed_msg_data,
            cleaned_prompt,
            resolution,
            edit: edit_msg,
        })
        if (promise_data.data?.message) {
            for (const msg of promise_data.data.message) {
                if (msg.type === 'text' && edit_msg === false) {
                    const forward_msg_data = msg.data?.text
                    if (forward_msg_data) {
                        const merged_prompt = `${forward_msg_data}\r\n${cleaned_prompt}`.trim()
                        logInfo('enqueue image task from replied text', {
                            groupId: data.group_id,
                            userId: data.user_id,
                            prompt: merged_prompt,
                            resolution,
                            edit: false,
                            hasImageReference: false,
                        })
                        process_queue(ws, {
                            group_id: data.group_id,
                            data: merged_prompt,
                            user_id: data.user_id,
                            resolution,
                            edit: false
                        })
                        return
                    }
                }

                if (msg.type === 'image' && edit_msg === false) {
                    const img_url = msg.data?.url
                    if (img_url) {
                        logInfo('enqueue image task from replied image', {
                            groupId: data.group_id,
                            userId: data.user_id,
                            prompt: cleaned_prompt,
                            resolution,
                            edit: false,
                            hasImageReference: true,
                            img_url,
                        })
                        process_queue(ws, {
                            group_id: data.group_id,
                            data: cleaned_prompt,
                            user_id: data.user_id,
                            resolution,
                            edit: false,
                            img_url,
                        })
                        return
                    }
                }
                else if (msg.type === 'image' && edit_msg === true) {
                    const img_url = msg.data.url
                    logInfo('enqueue edit image task from replied image', {
                        groupId: data.group_id,
                        userId: data.user_id,
                        prompt: cleaned_prompt,
                        resolution,
                        edit: true,
                        hasImageReference: true,
                        img_url,
                    })
                    process_queue(ws, {
                        group_id: data.group_id,
                        data: cleaned_prompt,
                        user_id: data.user_id,
                        resolution,
                        edit: true,
                        img_url,
                    })
                }
            }
        }
        return
    }

    const chunked_data = cleaned_prompt
    logInfo('enqueue direct image task', {
        groupId: data.group_id,
        userId: data.user_id,
        raw_text: trimed_msg_data,
        prompt: chunked_data,
        resolution,
        edit: false,
        hasImageReference: false,
    })
    process_queue(ws, {
        group_id: data.group_id,
        data: chunked_data,
        user_id: data.user_id,
        resolution,
        edit: false
    })
}

ws.on("message", async (raw_data) => {
    logDebug('message received')
    let reply_msg = false
    let cur_reply_msg_id = null
    const data = JSON.parse(raw_data)

    if (data?.status && data?.echo) {
        const pending = pendingMap.get(data.echo)
        if (pending) {
            pending.resolve(data)
            pendingMap.delete(data.echo)
            return
        }

        if (String(data.echo).startsWith('send_')) {
            logInfo('action response', {
                echo: data.echo,
                status: data.status,
                retcode: data.retcode,
                message: data.message,
                wording: data.wording,
                data: data.data,
            })
            return
        }
    }

    if (data?.self_id) {
        self_qq_id = data.self_id
        logInfo('login info loaded', { self_qq_id })
    }

    logDebug('incoming payload', data)
    if (!WHITELIST.includes(String(data.group_id))) {
        return
    }

    logDebug('message in whitelist group', { groupId: data.group_id })

    try {
        for (const msg_data of data.message) {
            if (msg_data.type === 'reply') {
                reply_msg = true
                cur_reply_msg_id = msg_data.data.id
                logDebug('reply message detected', { replyId: cur_reply_msg_id })
            }

            if (msg_data.type === 'text' && msg_data?.data?.text) {
                const text = msg_data.data.text.trim()

                if (text.includes('/help')) {
                    const help_msg = [
                        'bot 帮助',
                        '#画图 提示词',
                        '回复图片后 反推',
                        '回复文本/图片后 Chat 问题',
                        '3K_H / 3K_V 可选',
                        '',
                        '示例：',
                        '#画图 赛博朋克猫娘 3K_V',
                        '回复图片：反推',
                        '回复图片：Chat 这张图哪里还能优化？',
                    ].join('\r\n')
                    sendGroupMsg(ws, data.group_id, help_msg, data.user_id)
                    return
                }

                if (text.startsWith('#画图')) {
                    put_img_in_queue(ws, msg_data, cur_reply_msg_id, data, false, false)
                    return
                }

                if (text.startsWith('改图') && reply_msg) {
                    sendGroupMsg(ws, data.group_id, '当前图像接口仅支持 #画图 文生图，不支持改图。', data.user_id)
                    return
                }

                if (text.toLowerCase().startsWith('chat') && reply_msg) {
                    const promise_data = await get_msg_byID(ws, cur_reply_msg_id)
                    logDebug('gen chat msg', promise_data)
                    if (promise_data.data?.message) {
                        for (const msg of promise_data.data.message) {
                            if (msg.type === 'image' && msg.data?.url) {
                                const chat_return = await chat_with_content(msg.data.url, null, msg_data.data.text)
                                sendGroupMsg(ws, data.group_id, chat_return, data.user_id)
                            }
                            if (msg.type === 'text' && msg.data?.text) {
                                const chat_return = await chat_with_content(null, msg.data.text, msg_data.data.text)
                                sendGroupMsg(ws, data.group_id, chat_return, data.user_id)
                            }
                        }
                        return
                    }
                }

                if (text.startsWith('反推') && reply_msg) {
                    const promise_data = await get_msg_byID(ws, cur_reply_msg_id)
                    logDebug('reply target fetched', promise_data)
                    if (promise_data.data?.message) {
                        for (const msg of promise_data.data.message) {
                            if (msg.type === 'image' && msg.data?.url) {
                                logInfo('start image description', { url: msg.data.url })
                                const img_info = await get_discrption_from_img(msg.data.url, msg_data.data.text)
                                sendGroupMsg(ws, data.group_id, img_info, data.user_id)
                            }
                        }
                        return
                    }
                }
            }
        }
    } catch (err) {
        logError(err)
    }
})
