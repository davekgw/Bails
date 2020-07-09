import WhatsAppWebBase from './Base'
import fetch from 'node-fetch'
import {
    MessageOptions,
    MessageType,
    Mimetype,
    MimetypeMap,
    MediaPathMap,
    WALocationMessage,
    WAContactMessage,
    WASendMessageResponse,
    WAMessageKey,
    ChatModification,
} from './Constants'
import { generateMessageID, sha256, hmacSign, aesEncrypWithIV, randomBytes } from '../WAConnection/Utils'
import { WAMessageContent, WAMetric, WAFlag, WANode, WAMessage } from '../WAConnection/Constants'
import { validateJIDForSending, generateThumbnail, getMediaKeys } from './Utils'
import { proto } from '../../WAMessage/WAMessage'

export default class WhatsAppWebMessages extends WhatsAppWebBase {
    /**
     * Send a read receipt to the given ID for a certain message
     * @param {string} jid the ID of the person/group whose message you want to mark read
     * @param {string} [messageID] optionally, the message ID
     */
    async sendReadReceipt(jid: string, messageID?: string, type: 'read' | 'unread' = 'read') {
        const attributes = {
            jid: jid, 
            count: messageID ? '1' : null, 
            index: messageID, 
            owner: 'false',
            type: type==='unread' && 'false'
        }
        return this.setQuery ([['read', attributes, null]])
    }
    /** Mark a given chat as unread */
    async markChatUnread (jid: string) { return this.sendReadReceipt (jid, null, 'unread') }
    async archiveChat (jid: string) { return this.modifyChat (jid, ChatModification.archive) }
    /**
     * Modify a given chat (archive, pin etc.)
     * @param jid the ID of the person/group you are modifiying
     * @param options.stamp the timestamp of pinning/muting the chat. Is required when unpinning/unmuting 
     */
    async modifyChat (jid: string, type: ChatModification, options: {stamp: Date | string} = {stamp: new Date()}) {
        let chatAttrs: Record<string, string> = {jid: jid}
        if ((type === ChatModification.unpin || type === ChatModification.unmute) && !options?.stamp) {
            throw 'options.stamp must be set to the timestamp of the time of pinning/unpinning of the chat'
        }
        const strStamp = options.stamp && 
                        (typeof options.stamp === 'string' ? options.stamp : Math.round(options.stamp.getTime ()/1000).toString ())
        switch (type) {
            case ChatModification.pin:
            case ChatModification.mute:
                chatAttrs.type = type
                chatAttrs[type] = strStamp
                break
            case ChatModification.unpin:
            case ChatModification.unmute:
                chatAttrs.type = type.replace ('un', '') // replace 'unpin' with 'pin'
                chatAttrs.previous = strStamp
                break
            default:
                chatAttrs.type = type
                break
        }
        console.log (chatAttrs)
        let response = await this.setQuery ([['chat', chatAttrs, null]]) as any
        response.stamp = strStamp
        return response as {status: number, stamp: string}
    }
    /**
     * Search WhatsApp messages with a given text string
     * @param txt the search string
     * @param count number of results to return
     * @param page page number of results
     */
    async searchMessages(txt: string, count: number, page: number) {
        const json = [
            'query',
            { 
                epoch: this.msgCount.toString(), 
                type: 'search',
                search: txt,
                count: count.toString(),
                page: page.toString()
            },
            null,
        ]
        const response: WANode = await this.queryExpecting200(json, [WAMetric.group, WAFlag.ignore]) // encrypt and send  off
        const messages = response[2] ? response[2].map (row => row[2]) : []
        return { last: response[1]['last'] === 'true', messages: messages as WAMessage[] }
    }
    /**
     * Delete a message in a chat for yourself
     * @param messageKey key of the message you want to delete
     */
    async clearMessage (messageKey: WAMessageKey) {
        const tag = Math.round(Math.random ()*1000000)
        const attrs: WANode = [
            'chat',
            { jid: messageKey.remoteJid, modify_tag: tag.toString(), type: 'clear' },
            [
                ['item', {owner: `${messageKey.fromMe}`, index: messageKey.id}, null]
            ]
        ]
        return this.setQuery ([attrs])
    }
    /**
     * Delete a message in a chat for everyone
     * @param id the person or group where you're trying to delete the message
     * @param messageKey key of the message you want to delete
     */
    async deleteMessage (id: string, messageKey: WAMessageKey) {
        const json: WAMessageContent = {
            protocolMessage: {
                key: messageKey,
                type: proto.ProtocolMessage.PROTOCOL_MESSAGE_TYPE.REVOKE
            }
        }
        return this.sendGenericMessage (id, json, {})
    }
    async sendMessage(
        id: string,
        message: string | WALocationMessage | WAContactMessage | Buffer,
        type: MessageType,
        options: MessageOptions = {},
    ) {
        if (options.validateID === true || !('validateID' in options)) {
            validateJIDForSending (id)
        }
        let m: any = {}
        switch (type) {
            case MessageType.text:
            case MessageType.extendedText:
                if (typeof message !== 'string') {
                    throw 'expected message to be a string'
                }
                m.extendedTextMessage = { text: message }
                break
            case MessageType.location:
            case MessageType.liveLocation:
                m.locationMessage = message as WALocationMessage
                break
            case MessageType.contact:
                m.contactMessage = message as WAContactMessage
                break
            default:
                m = await this.prepareMediaMessage(message as Buffer, type, options)
                break
        }
        return this.sendGenericMessage(id, m as WAMessageContent, options)
    }
    /** Prepare a media message for sending */
    protected async prepareMediaMessage(buffer: Buffer, mediaType: MessageType, options: MessageOptions = {}) {
        if (mediaType === MessageType.document && !options.mimetype) {
            throw 'mimetype required to send a document'
        }
        if (mediaType === MessageType.sticker && options.caption) {
            throw 'cannot send a caption with a sticker'
        }
        if (!options.mimetype) {
            options.mimetype = MimetypeMap[mediaType]
        }
        let isGIF = false
        if (options.mimetype === Mimetype.gif) {
            isGIF = true
            options.mimetype = MimetypeMap[MessageType.video]
        }
        // generate a media key
        const mediaKey = randomBytes(32)
        const mediaKeys = getMediaKeys(mediaKey, mediaType)
        const enc = aesEncrypWithIV(buffer, mediaKeys.cipherKey, mediaKeys.iv)
        const mac = hmacSign(Buffer.concat([mediaKeys.iv, enc]), mediaKeys.macKey).slice(0, 10)
        const body = Buffer.concat([enc, mac]) // body is enc + mac
        const fileSha256 = sha256(buffer)
        // url safe Base64 encode the SHA256 hash of the body
        const fileEncSha256B64 = sha256(body)
            .toString('base64')
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/\=+$/, '')

        await generateThumbnail(buffer, mediaType, options)
        // send a query JSON to obtain the url & auth token to upload our media
        const json = (await this.query(['query', 'mediaConn'])).media_conn
        const auth = json.auth // the auth token
        let hostname = 'https://' + json.hosts[0].hostname // first hostname available
        hostname += MediaPathMap[mediaType] + '/' + fileEncSha256B64 // append path
        hostname += '?auth=' + auth // add auth token
        hostname += '&token=' + fileEncSha256B64 // file hash

        const urlFetch = await fetch(hostname, {
            method: 'POST',
            body: body,
            headers: { Origin: 'https://web.whatsapp.com' },
        })
        const responseJSON = await urlFetch.json()
        if (!responseJSON.url) {
            throw 'UPLOAD FAILED GOT: ' + JSON.stringify(responseJSON)
        }
        const message = {}
        message[mediaType] = {
            url: responseJSON.url,
            mediaKey: mediaKey.toString('base64'),
            mimetype: options.mimetype,
            fileEncSha256: fileEncSha256B64,
            fileSha256: fileSha256.toString('base64'),
            fileLength: buffer.length,
            gifPlayback: isGIF || null,
        }
        return message
    }
    /** Generic send message function */
    async sendGenericMessage(id: string, message: WAMessageContent, options: MessageOptions) {
        if (!options.timestamp) {
            // if no timestamp was provided,
            options.timestamp = new Date() // set timestamp to now
        }
        const key = Object.keys(message)[0]
        const timestamp = options.timestamp.getTime() / 1000
        const quoted = options.quoted
        if (quoted) {
            const participant = quoted.key.participant || quoted.key.remoteJid
            message[key].contextInfo = {
                participant: participant,
                stanzaId: quoted.key.id,
                quotedMessage: quoted.message,
            }
            // if a participant is quoted, then it must be a group
            // hence, remoteJid of group must also be entered
            if (quoted.key.participant) {
                message[key].contextInfo.remoteJid = quoted.key.remoteJid
            }
        }
        message[key].caption = options?.caption
        message[key].jpegThumbnail = options?.thumbnail

        const messageJSON = {
            key: {
                remoteJid: id,
                fromMe: true,
                id: generateMessageID(),
            },
            message: message,
            messageTimestamp: timestamp,
            participant: id.includes('@g.us') ? this.userMetaData.id : null,
        }
        const json = ['action', {epoch: this.msgCount.toString(), type: 'relay'}, [['message', null, messageJSON]]]
        const response = await this.queryExpecting200(json, [WAMetric.message, WAFlag.ignore], null, messageJSON.key.id)
        return { status: response.status as number, messageID: messageJSON.key.id } as WASendMessageResponse
    }
}