var roamgateRenderedHelper = (function() {
	// ../shared/renderedPage.ts
	var RENDERED_STORAGE_MAX_CHARS = 262144;
	var RENDERED_THREAD_KEYS = [
		"j",
		"k",
		"n",
		"N",
		"g",
		"G",
		"H",
		"z",
		"a",
		"t",
		"b",
		"c",
		"R",
		"r",
		"d",
		"T",
		";",
		"o",
		"Escape",
		":",
		"0",
		"1",
		"2",
		"3",
		"4",
		"5",
		"6",
		"7",
		"8",
		"9"
	];
	// ../shared/svgAsDrawn.ts
	function svgAsDrawn(svg) {
		const smil = "animate, animateTransform, animateMotion, set";
		if (svg.animationsPaused()) svg.setCurrentTime(svg.getCurrentTime());
		const styles = [
			"transform",
			"transform-origin",
			"transform-box",
			"opacity",
			"fill",
			"fill-opacity",
			"stroke",
			"stroke-opacity",
			"stroke-width",
			"stroke-dasharray",
			"stroke-dashoffset",
			"visibility",
			"display",
			"color",
			"font-family",
			"font-size",
			"font-weight"
		];
		const clone = svg.cloneNode(true);
		const live = [svg, ...svg.querySelectorAll("*")];
		const copies = [clone, ...clone.querySelectorAll("*")];
		live.forEach((element, index) => {
			const copy = copies[index];
			if (!copy || element.matches(smil) || element.closest("style")) return;
			const computed = getComputedStyle(element);
			const moved = element.querySelector(":scope > animateTransform, :scope > animateMotion");
			const rules = styles.filter((name) => !(moved && name === "transform")).map((name) => `${name}:${computed.getPropertyValue(name)}`).filter((rule) => !rule.endsWith(":"));
			rules.push("animation:none", "transition:none");
			copy.setAttribute("style", `${copy.getAttribute("style") ?? ""};${rules.join(";")}`);
			for (const animation of element.querySelectorAll(":scope > animate, :scope > set")) {
				const name = animation.getAttribute("attributeName");
				if (!name || /^on|href$/i.test(name)) continue;
				const property = element[name];
				const current = property === null || property === void 0 ? void 0 : property.animVal;
				const text = (current === null || current === void 0 ? void 0 : current.valueAsString) ?? (typeof (current === null || current === void 0 ? void 0 : current.value) === "number" || typeof (current === null || current === void 0 ? void 0 : current.value) === "string" ? String(current.value) : computed.getPropertyValue(name) || void 0);
				if (text !== void 0) copy.setAttribute(name, text);
			}
			if (moved && element instanceof SVGGraphicsElement) {
				const own = element.getCTM();
				const parent = element.parentElement instanceof SVGGraphicsElement ? element.parentElement.getCTM() : null;
				const matrix = own && parent ? parent.inverse().multiply(own) : own;
				if (matrix) copy.setAttribute("transform", `matrix(${matrix.a} ${matrix.b} ${matrix.c} ${matrix.d} ${matrix.e} ${matrix.f})`);
			}
		});
		for (const animation of clone.querySelectorAll(smil)) animation.remove();
		const box = svg.getBoundingClientRect();
		clone.setAttribute("width", String(box.width));
		clone.setAttribute("height", String(box.height));
		if (!clone.getAttribute("xmlns")) clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
		return new XMLSerializer().serializeToString(clone);
	}
	// src/renderedHelper.ts
	var KEYS = RENDERED_THREAD_KEYS;
	var LIMITS = {
		chars: RENDERED_STORAGE_MAX_CHARS,
		keys: 200
	};
	var asDrawn = svgAsDrawn;
	function renderedHelper(PREFIX, ROOT, STORE) {
		const w = window;
		const d = document;
		if (w.__roamgateRendered) return;
		w.__roamgateRendered = true;
		const parentWindow = w.parent;
		if (STORE) {
			const makeStorage = (seed, persist) => {
				const items = new Map(Object.entries(seed));
				const chars = () => {
					let total = 0;
					items.forEach((value, key) => {
						total += key.length + value.length;
					});
					return total;
				};
				const send = (write) => {
					if (!persist || !parentWindow || parentWindow === w) return;
					try {
						parentWindow.postMessage({
							roamgate: "rendered",
							type: "storage",
							...write
						}, "*");
					} catch {}
				};
				const quota = () => {
					const message = "The quota has been exceeded.";
					if (typeof DOMException === "function") return new DOMException(message, "QuotaExceededError");
					const error = new Error(message);
					error.name = "QuotaExceededError";
					return error;
				};
				const api = {
					getItem(key) {
						const value = items.get(String(key));
						return value === void 0 ? null : value;
					},
					setItem(key, value) {
						const name = String(key);
						const text = String(value);
						const before = items.get(name);
						if (before === text) return;
						const grown = chars() - (before === void 0 ? 0 : name.length + before.length);
						if (name.length === 0 || grown + name.length + text.length > LIMITS.chars || before === void 0 && items.size >= LIMITS.keys) throw quota();
						items.set(name, text);
						send({
							op: "set",
							key: name,
							value: text
						});
					},
					removeItem(key) {
						const name = String(key);
						if (!items.delete(name)) return;
						send({
							op: "remove",
							key: name
						});
					},
					clear() {
						if (!items.size) return;
						items.clear();
						send({ op: "clear" });
					},
					key(index) {
						const found = Array.from(items.keys())[Number(index)];
						return found === void 0 ? null : found;
					}
				};
				const target = {};
				for (const name of Object.keys(api)) Object.defineProperty(target, name, {
					value: api[name],
					configurable: true,
					writable: true
				});
				Object.defineProperty(target, "length", {
					get: () => items.size,
					configurable: true
				});
				return new Proxy(target, {
					get(self, name, receiver) {
						if (typeof name === "symbol") return name === Symbol.toStringTag ? "Storage" : Reflect.get(self, name, receiver);
						if (Object.prototype.hasOwnProperty.call(self, name)) return Reflect.get(self, name, receiver);
						return items.get(name);
					},
					set(_self, name, value) {
						if (typeof name === "symbol") return false;
						api.setItem(name, value);
						return true;
					},
					deleteProperty(_self, name) {
						if (typeof name === "symbol") return false;
						api.removeItem(name);
						return true;
					},
					has(self, name) {
						return typeof name === "string" && items.has(name) || name in self;
					},
					ownKeys() {
						return Array.from(items.keys());
					},
					getOwnPropertyDescriptor(self, name) {
						if (typeof name === "string" && items.has(name)) return {
							value: items.get(name),
							writable: true,
							enumerable: true,
							configurable: true
						};
						return Reflect.getOwnPropertyDescriptor(self, name);
					}
				});
			};
			const install = (name, storage) => {
				try {
					Object.defineProperty(w, name, {
						get: () => storage,
						configurable: true,
						enumerable: true
					});
				} catch {}
			};
			install("localStorage", makeStorage(STORE, true));
			install("sessionStorage", makeStorage({}, false));
		}
		if (!parentWindow || parentWindow === w) return;
		let pointMode = false;
		let selected = false;
		const post = (message) => {
			try {
				parentWindow.postMessage({
					roamgate: "rendered",
					...message
				}, "*");
			} catch {}
		};
		const pageUrl = () => {
			const path = location.pathname;
			return ((path.indexOf(PREFIX) === 0 ? path.slice(PREFIX.length) : path) + location.search).slice(0, 2048);
		};
		const cssEscape = (value) => w.CSS && CSS.escape ? CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
		const selectorOf = (start) => {
			const parts = [];
			let el = start;
			while (el && el.nodeType === 1 && parts.length < 12) {
				if (el.id && d.querySelectorAll(`#${cssEscape(el.id)}`).length === 1) {
					parts.unshift(`#${cssEscape(el.id)}`);
					break;
				}
				const tag = el.tagName.toLowerCase();
				if (tag === "html" || tag === "body") {
					parts.unshift(tag);
					break;
				}
				let index = 1;
				let sibling = el.previousElementSibling;
				while (sibling) {
					if (sibling.tagName === el.tagName) index += 1;
					sibling = sibling.previousElementSibling;
				}
				parts.unshift(`${tag}:nth-of-type(${index})`);
				el = el.parentElement;
			}
			return parts.join(" > ").slice(0, 1e3);
		};
		const rectOf = (r) => ({
			x: r.left,
			y: r.top,
			w: r.width,
			h: r.height
		});
		const size = () => post({
			type: "size",
			height: d.body ? d.body.getBoundingClientRect().height : 0
		});
		const ORIGIN = `${location.protocol}//${location.host}`;
		const mapUrl = (url) => {
			if (typeof url !== "string") return url;
			let path = url.trim();
			if (path.indexOf(`${ORIGIN}/`) === 0) path = path.slice(ORIGIN.length);
			if (path.charAt(0) !== "/" || /^\/[/\\]/.test(path)) return url;
			if (path.indexOf("/rendered/") === 0 || path.indexOf(ROOT.base) !== 0) return url;
			return ROOT.to + path.slice(ROOT.base.length);
		};
		const URL_ATTRIBUTES = [
			"href",
			"src",
			"action",
			"formaction",
			"poster",
			"data"
		];
		const fixElement = (el) => {
			for (const name of URL_ATTRIBUTES) {
				if (name === "data" && el.tagName !== "OBJECT") continue;
				const value = el.getAttribute(name);
				if (value === null) continue;
				const mapped = mapUrl(value);
				if (mapped !== value) el.setAttribute(name, mapped);
			}
			const set = el.getAttribute("srcset");
			if (set !== null) {
				const mapped = set.split(",").map((part) => part.replace(/^(\s*)(\S+)/, (_m, space, url) => space + mapUrl(url))).join(",");
				if (mapped !== set) el.setAttribute("srcset", mapped);
			}
		};
		const fixTree = (node) => {
			if (node.nodeType !== 1) return;
			const el = node;
			fixElement(el);
			const inner = el.querySelectorAll("[href],[src],[action],[formaction],[poster],[data],[srcset]");
			for (let i = 0; i < inner.length; i += 1) fixElement(inner[i]);
		};
		if (w.MutationObserver) new MutationObserver((records) => {
			for (const record of records) if (record.type === "attributes") fixElement(record.target);
			else for (let i = 0; i < record.addedNodes.length; i += 1) fixTree(record.addedNodes[i]);
		}).observe(d.documentElement, {
			subtree: true,
			childList: true,
			attributes: true,
			attributeFilter: URL_ATTRIBUTES.concat("srcset")
		});
		d.addEventListener("click", (event) => {
			const target = event.target;
			const link = (target === null || target === void 0 ? void 0 : target.closest) ? target.closest("a[href], area[href]") : null;
			if (link) fixElement(link);
		}, true);
		d.addEventListener("submit", (event) => {
			if (event.target instanceof Element) fixElement(event.target);
		}, true);
		if (typeof w.fetch === "function") {
			const fetchPage = w.fetch;
			w.fetch = function(input, init) {
				return fetchPage.call(w, typeof input === "string" ? mapUrl(input) : input, init);
			};
		}
		if (w.XMLHttpRequest) {
			const open = w.XMLHttpRequest.prototype.open;
			w.XMLHttpRequest.prototype.open = function(...args) {
				args[1] = mapUrl(args[1]);
				return open.apply(this, args);
			};
		}
		const openWindow = w.open;
		if (typeof openWindow === "function") w.open = function(url, ...rest) {
			return openWindow.call(w, mapUrl(url), ...rest);
		};
		for (const name of ["pushState", "replaceState"]) {
			var _w$history;
			const original = (_w$history = w.history) === null || _w$history === void 0 ? void 0 : _w$history[name];
			if (typeof original !== "function") continue;
			w.history[name] = function(data, unused, url) {
				const done = original.call(this, data, unused, mapUrl(url));
				if (name === "pushState") post({
					type: "location",
					url: pageUrl()
				});
				return done;
			};
		}
		let scrollTimer = 0;
		w.addEventListener("scroll", () => {
			w.clearTimeout(scrollTimer);
			scrollTimer = w.setTimeout(() => post({
				type: "scroll",
				y: w.scrollY
			}), 120);
		}, { passive: true });
		const ready = () => {
			post({
				type: "ready",
				url: pageUrl(),
				title: d.title,
				root: ROOT
			});
			size();
			if (w.ResizeObserver && d.body) new ResizeObserver(size).observe(d.body);
		};
		if (d.readyState === "loading") d.addEventListener("DOMContentLoaded", ready);
		else ready();
		let pending = 0;
		const reportSelection = () => {
			clearTimeout(pending);
			pending = w.setTimeout(() => {
				const selection = w.getSelection();
				if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) {
					if (selected) post({ type: "clear" });
					selected = false;
					return;
				}
				const quote = selection.toString().trim().slice(0, 4e3);
				if (!quote) return;
				const range = selection.getRangeAt(0);
				const node = range.commonAncestorContainer;
				const element = node.nodeType === 1 ? node : node.parentElement;
				selected = true;
				post({
					type: "select",
					url: pageUrl(),
					quote,
					selector: selectorOf(element),
					rect: rectOf(range.getBoundingClientRect())
				});
			}, 120);
		};
		d.addEventListener("mouseup", reportSelection);
		d.addEventListener("keyup", reportSelection);
		const typing = (target) => !!target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName || ""));
		d.addEventListener("keydown", (event) => {
			if (event.defaultPrevented || event.ctrlKey || event.metaKey) return;
			if (event.altKey || event.key === ":" || KEYS.indexOf(event.key) < 0) return;
			if (typing(event.target)) return;
			event.preventDefault();
			post({
				type: "key",
				key: event.key
			});
		});
		window.addEventListener("keydown", (event) => {
			if (!event.shiftKey && !event.ctrlKey) {
				const step = event.altKey && !event.metaKey ? event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0 : event.metaKey && !event.altKey ? event.key === "[" ? -1 : event.key === "]" ? 1 : 0 : 0;
				if (step && !typing(event.target)) {
					event.preventDefault();
					event.stopImmediatePropagation();
					post({
						type: "history",
						step
					});
					return;
				}
			}
			if (event.key !== ":" || event.ctrlKey || event.metaKey) return;
			if (KEYS.indexOf(":") < 0) return;
			if (typing(event.target)) return;
			event.preventDefault();
			event.stopImmediatePropagation();
			post({
				type: "key",
				key: ":"
			});
		}, true);
		const graphicOf = (target) => {
			var _graphic$parentElemen;
			let graphic = target.closest("svg, img, canvas, video");
			while (graphic && ((_graphic$parentElemen = graphic.parentElement) === null || _graphic$parentElemen === void 0 ? void 0 : _graphic$parentElemen.closest("svg"))) graphic = graphic.parentElement.closest("svg");
			return graphic ?? target;
		};
		let held = [];
		const seconds = (value) => `${Math.round(value * 10) / 10} s`;
		const hold = (graphic) => {
			let moment;
			const svg = graphic.tagName.toLowerCase() === "svg" ? graphic : null;
			if (svg && svg.querySelector("animate, animateTransform, animateMotion, set")) {
				if (!svg.animationsPaused()) {
					svg.pauseAnimations();
					held.push(() => svg.unpauseAnimations());
				}
				moment = seconds(svg.getCurrentTime());
			}
			const animations = typeof graphic.getAnimations === "function" ? graphic.getAnimations({ subtree: true }) : [];
			for (const animation of animations) {
				if (animation.playState !== "running") continue;
				animation.pause();
				held.push(() => animation.play());
				if (moment === void 0 && typeof animation.currentTime === "number") moment = seconds(animation.currentTime / 1e3);
			}
			if (graphic.tagName.toLowerCase() === "video") {
				const video = graphic;
				if (!video.paused) {
					video.pause();
					held.push(() => {
						video.play().catch(() => void 0);
					});
				}
				moment = moment ?? seconds(video.currentTime);
			}
			return moment;
		};
		const picture = (graphic, region) => new Promise((resolve) => {
			const box = graphic.getBoundingClientRect();
			const draw = (source, width, height) => {
				try {
					const whole = !region.w || !region.h;
					const sx = whole ? 0 : region.x * width;
					const sy = whole ? 0 : region.y * height;
					const sw = whole ? width : Math.max(1, region.w * width);
					const sh = whole ? height : Math.max(1, region.h * height);
					const scale = Math.min(1600 / Math.max(sw, sh), 2);
					const canvas = d.createElement("canvas");
					canvas.width = Math.max(1, Math.round(sw * scale));
					canvas.height = Math.max(1, Math.round(sh * scale));
					const context = canvas.getContext("2d");
					if (!context) return resolve(void 0);
					context.fillStyle = "#fff";
					context.fillRect(0, 0, canvas.width, canvas.height);
					context.drawImage(source, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
					const url = canvas.toDataURL("image/png");
					resolve(url.length <= 4194304 ? url : void 0);
				} catch {
					resolve(void 0);
				}
			};
			const tag = graphic.tagName.toLowerCase();
			if (tag === "img") {
				const image = graphic;
				return draw(image, image.naturalWidth || box.width, image.naturalHeight || box.height);
			}
			if (tag === "canvas" || tag === "video") {
				const media = graphic;
				const width = tag === "video" ? media.videoWidth : media.width;
				const height = tag === "video" ? media.videoHeight : media.height;
				return draw(media, width || box.width, height || box.height);
			}
			if (tag !== "svg" || !box.width || !box.height) return resolve(void 0);
			try {
				const markup = asDrawn(graphic);
				const image = new Image();
				image.onload = () => draw(image, box.width, box.height);
				image.onerror = () => resolve(void 0);
				image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
			} catch {
				resolve(void 0);
			}
		});
		let start = null;
		d.addEventListener("mousedown", (event) => {
			if (!(event.altKey || pointMode) || event.button !== 0) return;
			if (!(event.target instanceof Element)) return;
			start = {
				x: event.clientX,
				y: event.clientY,
				target: event.target
			};
			event.preventDefault();
		}, true);
		d.addEventListener("mouseup", (event) => {
			const begun = start;
			start = null;
			if (!begun) return;
			event.preventDefault();
			const graphic = graphicOf(begun.target);
			const box = graphic.getBoundingClientRect();
			if (!box.width || !box.height) return;
			const clamp = (value) => Math.min(1, Math.max(0, value));
			const x1 = clamp((begun.x - box.left) / box.width);
			const y1 = clamp((begun.y - box.top) / box.height);
			const x2 = clamp((event.clientX - box.left) / box.width);
			const y2 = clamp((event.clientY - box.top) / box.height);
			const region = Math.abs(event.clientX - begun.x) > 4 || Math.abs(event.clientY - begun.y) > 4 ? {
				x: Math.min(x1, x2),
				y: Math.min(y1, y2),
				w: Math.abs(x2 - x1),
				h: Math.abs(y2 - y1)
			} : {
				x: x1,
				y: y1,
				w: 0,
				h: 0
			};
			const named = begun.target.closest("[id]");
			const element = named && graphic.contains(named) && named.id || (begun.target.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 80);
			const moment = hold(graphic);
			const send = (snapshot) => post({
				type: "point",
				url: pageUrl(),
				selector: selectorOf(graphic),
				region,
				rect: rectOf(box),
				...element ? { element } : {},
				...moment ? { moment } : {},
				...snapshot ? { snapshot } : {}
			});
			picture(graphic, region).then(send, () => send());
		}, true);
		const style = d.createElement("style");
		style.textContent = "a, a * { -webkit-user-drag: none; user-select: text; }a:empty { pointer-events: none; }html[data-roamgate-point], html[data-roamgate-point] * { cursor: crosshair !important; }";
		(d.head ?? d.documentElement).appendChild(style);
		d.addEventListener("click", (event) => {
			if (event.altKey || pointMode) {
				event.preventDefault();
				return;
			}
			const selection = w.getSelection();
			if (selection && !selection.isCollapsed && selection.toString().trim()) event.preventDefault();
		}, true);
		const INTERACTIVE = "a, button, input, select, textarea, summary, label, [role=button], [contenteditable]";
		let followTimer = 0;
		const cardLinkAt = (x, y) => {
			let best = null;
			let bestArea = Infinity;
			const links = d.querySelectorAll("a:empty[href]");
			for (let i = 0; i < links.length; i++) {
				const rect = links[i].getBoundingClientRect();
				if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) continue;
				const area = rect.width * rect.height;
				if (area < bestArea) {
					best = links[i];
					bestArea = area;
				}
			}
			return best;
		};
		const hasSelectedText = () => {
			const selection = w.getSelection();
			return !!selection && !selection.isCollapsed && !!selection.toString().trim();
		};
		d.addEventListener("click", (event) => {
			if (event.detail > 1 && followTimer) {
				w.clearTimeout(followTimer);
				followTimer = 0;
			}
			if (event.altKey || pointMode) return;
			if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey) return;
			if (hasSelectedText() || event.detail > 1) return;
			const target = event.target;
			if (target && target.closest && target.closest(INTERACTIVE)) return;
			const link = cardLinkAt(event.clientX, event.clientY);
			if (!link) return;
			if (followTimer) w.clearTimeout(followTimer);
			followTimer = w.setTimeout(() => {
				followTimer = 0;
				if (!hasSelectedText()) link.click();
			}, 250);
		}, true);
		let cardCursor = false;
		d.addEventListener("mousemove", (event) => {
			if (pointMode) return;
			const over = event.buttons === 0 && !hasSelectedText() && !!cardLinkAt(event.clientX, event.clientY);
			if (over === cardCursor) return;
			cardCursor = over;
			d.documentElement.style.cursor = over ? "pointer" : "";
		}, true);
		const flash = (element) => {
			element.scrollIntoView({ block: "center" });
			const html = element;
			if (!html.style) return;
			const before = html.style.outline;
			html.style.outline = "3px solid rgba(255, 170, 0, 0.9)";
			w.setTimeout(() => {
				html.style.outline = before;
			}, 1600);
		};
		const findQuote = (quote) => {
			const needle = quote.replace(/\s+/g, " ").trim().slice(0, 60);
			if (!needle) return null;
			const walker = d.createTreeWalker(d.body, NodeFilter.SHOW_TEXT);
			while (walker.nextNode()) {
				const node = walker.currentNode;
				if ((node.nodeValue ?? "").replace(/\s+/g, " ").includes(needle.slice(0, 30))) return node.parentElement;
			}
			return null;
		};
		w.addEventListener("message", (event) => {
			if (event.source !== parentWindow) return;
			const data = event.data;
			if (!data || data.roamgate !== "rendered") return;
			if (data.type === "pointMode") {
				pointMode = data.on === true;
				d.documentElement.style.cursor = pointMode ? "crosshair" : "";
				if (pointMode) d.documentElement.setAttribute("data-roamgate-point", "");
				else d.documentElement.removeAttribute("data-roamgate-point");
				return;
			}
			if (data.type === "scrollTo") {
				if (typeof data.y === "number" && Number.isFinite(data.y)) w.scrollTo(0, data.y);
				return;
			}
			if (data.type === "resume") {
				for (const resume of held.splice(0)) resume();
				held = [];
				return;
			}
			if (data.type !== "show") return;
			let element = null;
			if (typeof data.selector === "string" && data.selector) try {
				element = d.querySelector(data.selector);
			} catch {
				element = null;
			}
			if (typeof data.quote === "string" && data.quote) {
				const found = findQuote(data.quote);
				if (found && (!element || element.contains(found))) element = found;
			}
			if (element) flash(element);
		});
	}
	return renderedHelper;
})();
