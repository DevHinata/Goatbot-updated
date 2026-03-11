"use strict";

const utils = require("../utils");
const log = require("npmlog");
const bluebird = require("bluebird");

const allowedProperties = {
	attachment: true,
	url: true,
	sticker: true,
	emoji: true,
	emojiSize: true,
	body: true,
	mentions: true,
	location: true,
};

module.exports = function (defaultFuncs, api, ctx) {
	// --- Upload attachments ---
	function uploadAttachment(attachments, callback) {
		const uploads = [];
		for (let i = 0; i < attachments.length; i++) {
			if (!utils.isReadableStream(attachments[i]))
				throw { error: "Attachment should be a readable stream and not " + utils.getType(attachments[i]) + "." };

			const form = {
				upload_1024: attachments[i],
				voice_clip: "true",
			};

			uploads.push(
				defaultFuncs
					.postFormData("https://upload.facebook.com/ajax/mercury/upload.php", ctx.jar, form, {}, {})
					.then(utils.parseAndCheckLogin(ctx, defaultFuncs))
					.then(resData => {
						if (resData.error) throw resData;
						return resData.payload.metadata[0];
					})
			);
		}

		bluebird
			.all(uploads)
			.then(resData => callback(null, resData))
			.catch(err => {
				log.error("uploadAttachment", err);
				callback(err);
			});
	}

	// --- Handle URL attachments ---
	function getUrl(url, callback) {
		const form = { image_height: 960, image_width: 960, uri: url };

		defaultFuncs
			.post("https://www.facebook.com/message_share_attachment/fromURI/", ctx.jar, form)
			.then(utils.parseAndCheckLogin(ctx, defaultFuncs))
			.then(resData => {
				if (resData.error) return callback(resData);
				if (!resData.payload) return callback({ error: "Invalid url" });
				callback(null, resData.payload.share_data.share_params);
			})
			.catch(err => {
				log.error("getUrl", err);
				callback(err);
			});
	}

	// --- Send content ---
	function sendContent(form, threadID, isSingleUser, messageAndOTID, callback) {
		if (utils.getType(threadID) === "Array") {
			for (let i = 0; i < threadID.length; i++) form[`specific_to_list[${i}]`] = "fbid:" + threadID[i];
			form[`specific_to_list[${threadID.length}]`] = "fbid:" + ctx.userID;
			form.client_thread_id = "root:" + messageAndOTID;
			log.info("sendMessage", "Sending message to multiple users: " + threadID);
		} else {
			if (isSingleUser) {
				form["specific_to_list[0]"] = "fbid:" + threadID;
				form["specific_to_list[1]"] = "fbid:" + ctx.userID;
				form.other_user_fbid = threadID;
			} else form.thread_fbid = threadID;
		}

		if (ctx.globalOptions?.pageID) {
			form.author = "fbid:" + ctx.globalOptions.pageID;
			form[`specific_to_list[1]`] = "fbid:" + ctx.globalOptions.pageID;
			form["creator_info[creatorID]"] = ctx.userID;
			form["creator_info[creatorType]"] = "direct_admin";
			form["creator_info[labelType]"] = "sent_message";
			form["creator_info[pageID]"] = ctx.globalOptions.pageID;
			form.request_user_id = ctx.globalOptions.pageID;
			form["creator_info[profileURI]"] = "https://www.facebook.com/profile.php?id=" + ctx.userID;
		}

		defaultFuncs
			.post("https://www.facebook.com/messaging/send/", ctx.jar, form)
			.then(utils.parseAndCheckLogin(ctx, defaultFuncs))
			.then(resData => {
				if (!resData) return callback({ error: "Send message failed." });
				if (resData.error) {
					if (resData.error === 1545012) {
						log.warn("sendMessage", "Error 1545012: might not be part of conversation " + threadID);
					} else log.error("sendMessage", resData);
					return callback(resData);
				}
				const messageInfo = resData.payload.actions.reduce(
					(p, v) => ({
						threadID: v.thread_fbid,
						messageID: v.message_id,
						timestamp: v.timestamp,
					}) || p,
					null
				);
				callback(null, messageInfo);
			})
			.catch(err => {
				log.error("sendMessage", err);
				if (utils.getType(err) === "Object" && err.error === "Not logged in.") ctx.loggedIn = false;
				callback(err);
			});
	}

	function send(form, threadID, messageAndOTID, callback, isGroup) {
		if (utils.getType(threadID) === "Array") sendContent(form, threadID, false, messageAndOTID, callback);
		else {
			if (utils.getType(isGroup) !== "Boolean") sendContent(form, threadID, threadID.length === 15, messageAndOTID, callback);
			else sendContent(form, threadID, !isGroup, messageAndOTID, callback);
		}
	}

	// --- Handlers ---
	function handleUrl(msg, form, callback, cb) {
		if (!msg.url) return cb();
		form["shareable_attachment[share_type]"] = "100";
		getUrl(msg.url, (err, params) => {
			if (err) return callback(err);
			form["shareable_attachment[share_params]"] = params;
			cb();
		});
	}

	function handleLocation(msg, form, callback, cb) {
		if (!msg.location) return cb();
		if (msg.location.latitude == null || msg.location.longitude == null) return callback({ error: "location requires latitude & longitude" });
		form["location_attachment[coordinates][latitude]"] = msg.location.latitude;
		form["location_attachment[coordinates][longitude]"] = msg.location.longitude;
		form["location_attachment[is_current_location]"] = !!msg.location.current;
		cb();
	}

	function handleSticker(msg, form, callback, cb) {
		if (msg.sticker) form.sticker_id = msg.sticker;
		cb();
	}

	function handleEmoji(msg, form, callback, cb) {
		if (msg.emojiSize != null && !msg.emoji) return callback({ error: "emoji property empty" });
		if (!msg.emoji) return cb();
		if (!msg.emojiSize) msg.emojiSize = "medium";
		if (!["small", "medium", "large"].includes(msg.emojiSize)) return callback({ error: "emojiSize invalid" });
		if (form.body) return callback({ error: "body not empty" });
		form.body = msg.emoji;
		form["tags[0]"] = "hot_emoji_size:" + msg.emojiSize;
		cb();
	}

	function handleAttachment(msg, form, callback, cb) {
		if (!msg.attachment) return cb();
		form.image_ids = [];
		form.gif_ids = [];
		form.file_ids = [];
		form.video_ids = [];
		form.audio_ids = [];

		if (utils.getType(msg.attachment) !== "Array") msg.attachment = [msg.attachment];
		if (msg.attachment.every(e => /_id$/.test(e[0]))) {
			msg.attachment.forEach(e => form[`${e[0]}s`].push(e[1]));
			return cb();
		}

		uploadAttachment(msg.attachment, (err, files) => {
			if (err) return callback(err);
			files.forEach(file => {
				const type = Object.keys(file)[0];
				form[type + "s"].push(file[type]);
			});
			cb();
		});
	}

	function handleMention(msg, form, callback, cb) {
		if (!msg.mentions) return cb();
		for (let i = 0; i < msg.mentions.length; i++) {
			const mention = msg.mentions[i];
			const tag = mention.tag;
			if (typeof tag !== "string") return callback({ error: "Mention tags must be strings." });
			const offset = msg.body.indexOf(tag, mention.fromIndex || 0);
			if (offset < 0) log.warn("handleMention", `Mention for "${tag}" not found`);
			if (mention.id == null) log.warn("handleMention", "Mention id should be non-null");
			const id = mention.id || 0;
			const emptyChar = "\u200E";
			form.body = emptyChar + msg.body;
			form[`profile_xmd[${i}][offset]`] = offset + 1;
			form[`profile_xmd[${i}][length]`] = tag.length;
			form[`profile_xmd[${i}][id]`] = id;
			form[`profile_xmd[${i}][type]`] = "p";
		}
		cb();
	}

	// --- Main sendMessage ---
	return function sendMessage(msg, threadID, callback, replyToMessage, isGroup) {
		if (typeof isGroup === "undefined") isGroup = null;
		if (!callback && (utils.getType(threadID) === "Function" || utils.getType(threadID) === "AsyncFunction"))
			return threadID({ error: "Pass threadID as second argument." });
		if (!replyToMessage && utils.getType(callback) === "String") {
			replyToMessage = callback;
			callback = () => {};
		}

		let resolveFunc, rejectFunc;
		const returnPromise = new Promise((resolve, reject) => {
			resolveFunc = resolve;
			rejectFunc = reject;
		});
		if (!callback) callback = (err, data) => (err ? rejectFunc(err) : resolveFunc(data));

		const msgType = utils.getType(msg);
		const threadIDType = utils.getType(threadID);
		const messageIDType = utils.getType(replyToMessage);

		if (!["String", "Object"].includes(msgType)) return callback({ error: "Message should be string/object" });
		if (!["Array", "Number", "String"].includes(threadIDType)) return callback({ error: "ThreadID invalid" });
		if (replyToMessage && messageIDType !== "String") return callback({ error: "MessageID must be string" });

		if (msgType === "String") msg = { body: msg };
		const disallowedProps = Object.keys(msg).filter(p => !allowedProperties[p]);
		if (disallowedProps.length > 0) return callback({ error: "Disallowed props: `" + disallowedProps.join(", ") + "`" });

		const messageAndOTID = utils.generateOfflineThreadingID();

		const form = {
			client: "mercury",
			action_type: "ma-type:user-generated-message",
			author: "fbid:" + ctx.userID,
			timestamp: Date.now(),
			timestamp_absolute: "Today",
			timestamp_relative: utils.generateTimestampRelative(),
			timestamp_time_passed: "0",
			is_unread: false,
			is_cleared: false,
			is_forward: false,
			is_filtered_content: false,
			is_filtered_content_bh: false,
			is_filtered_content_account: false,
			is_filtered_content_quasar: false,
			is_filtered_content_invalid_app: false,
			is_spoof_warning: false,
			source: "source:chat:web",
			"source_tags[0]": "source:chat",
			body: msg.body ? msg.body.toString() : "",
			html_body: false,
			ui_push_phase: "V3",
			status: "0",
			offline_threading_id: messageAndOTID,
			message_id: messageAndOTID,
			threading_id: utils.generateThreadingID(ctx.clientID),
			"ephemeral_ttl_mode:": "0",
			manual_retry_cnt: "0",
			has_attachment: !!(msg.attachment || msg.url || msg.sticker),
			signatureID: utils.getSignatureID(),
			replied_to_message_id: replyToMessage,
			reply_metadata: replyToMessage
				? JSON.stringify({ reply_source_id: replyToMessage, reply_source_type: 1, reply_type: 0 })
				: undefined,
		};

		// --- Execute handlers with typing ---
		handleLocation(msg, form, callback, () =>
			handleSticker(msg, form, callback, () =>
				handleAttachment(msg, form, callback, () =>
					handleUrl(msg, form, callback, () =>
						handleEmoji(msg, form, callback, () =>
							handleMention(msg, form, callback, async () => {
								let typingStarted = false;
								let typingTimeout;

								if (ctx.globalOptions?.simulateTyping && api.sendTypingIndicator) {
									try {
										await api.sendTypingIndicator(true, threadID);
										typingStarted = true;
										const typingDelay = Math.min(Math.max(msg.body?.length * 50, 300), 5000); // 50ms per char
										await utils.delay(typingDelay);

										typingTimeout = setTimeout(() => {
											if (typingStarted) {
												try { api.sendTypingIndicator(false, threadID); } catch (_) {}
												typingStarted = false;
											}
										}, 10000);
									} catch (_) {}
								}

								try {
									const result = await new Promise((resolve, reject) => {
										send(form, threadID, messageAndOTID, (err, data) => (err ? reject(err) : resolve(data)), isGroup);
									});
									callback(null, result);
								} catch (err) {
									callback(err);
								} finally {
									if (typingTimeout) clearTimeout(typingTimeout);
									if (typingStarted) {
										try { await api.sendTypingIndicator(false, threadID); } catch (_) {}
									}
								}
							})
						)
					)
				)
			)
		);

		return returnPromise;
	};
};
