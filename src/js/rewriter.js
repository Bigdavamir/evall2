/* Eval Villain just jams this rewriter function into the loading page, withwwwwww
 * some JSON as CONFIG. Normally Firefox does this for you from the
 * background.js file. But you could always copy paste this code anywhere you
 * want. Such as into a proxie'd response or electron instramentation.
 */
const rewriter = function(CONFIG) {
  if (!window.EV_FOUND_SOURCES) window.EV_FOUND_SOURCES = [];

  // Robust hook for innerHTML and outerHTML to ensure we catch all sets,
  // even if other scripts have already hooked them.
  function applyRobustHook(propName) {
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, propName);

    // If there's no descriptor or no setter, we can't hook it.
    if (!descriptor || typeof descriptor.set !== 'function') {
      return;
    }

    // Avoid re-hooking if we've already applied our hook.
    if (descriptor.set._isEvalVillainHook) {
      return;
    }

    const originalSetter = descriptor.set;

    const newSetter = function(value) {
      // Call the main EvalVillain hook to process the sink.
      EvalVillainHook(INTRBUNDLE, `set(Element.${propName})`, [value]);

      // Chain the call to the original setter.
      return originalSetter.call(this, value);
    };

    // Flag our new setter to prevent re-hooking.
    newSetter._isEvalVillainHook = true;

    Object.defineProperty(Element.prototype, propName, {
      configurable: true, // Keep it configurable.
      enumerable: descriptor.enumerable,
      get: descriptor.get,
      set: newSetter
    });
  }

  applyRobustHook('innerHTML');
  applyRobustHook('outerHTML');

	// Filter out known unsupported navigation sinks to avoid warnings.
	// This is a secondary check; the primary filter is in background.js.
	CONFIG.functions = CONFIG.functions.filter(evname => {
		const NAV_SINKS = [
			"set(Location.href)",
			"value(Location.assign)",
			"value(Location.replace)"
		];
		if (NAV_SINKS.includes(evname)) {
			console.warn(`[EV] Skipping unsupported navigation sink: ${evname}`);
			return false;
		}
		return true;
	});

	const USER_SOURCE_KEY = 'eval_villain_user_sources';
	const MAX_USER_SOURCES = 50;

	// handled this way to preserve encoding...
	function getAllQueryParams(search) {
		return search.substr(search[0] == '?'? 1: 0)
			.split("&").map(x => x.split(/=(.*)/s));
	}

	class SourceFifo {
		constructor(limit) {
			this.limit = limit;
			this.fifo = [];
			this.set = new Set();
			this.removed = 0;
		}

		nq(sObj) {
			this.set.add(sObj.search);
			this.fifo.push(sObj);
			while (this.set.size > this.limit) {
				this.removed++;
				this.dq();
			}
			return this.removed;
		}

		dq() {
			const last = this.fifo.shift();
			this.set.delete(last.search);
			return last;
		}

		has(x) {
			return this.set.has(x);
		}

		*genAllMatches(str) {
			for (const sObj of this.fifo) {
				if (str.includes(sObj.search)) {
					yield sObj;
				}
			}
		}
	}

	/** hold all interest fifos */
	const ALLSOURCES = {}; // Used to hold all interest Fifo's

	function strSpliter(str, needle) {
		const ret = [];
		str.split(needle).forEach((x, index, arr)=> {
			ret.push(x)
			if (index != arr.length-1) {
				ret.push(needle)
			}
		});
		return ret;
	}

	function regexSpliter(str, needle) {
		const ret = [];
		if (needle.global == false) {
			// not global regex, so just split into two on first
			needle.lastIndex = 0;
			const m = needle.exec(str)[0];
			const l = str.split(m);
			ret.push(l[0], m, l[1]);
		} else {
			let holder = str;
			let match = null;
			needle.lastIndex = 0;
			let prevLast = 0;

			while ((match = needle.exec(str)) != null) {
				const m = match[0];
				ret.push(holder.substr(0, holder.indexOf(m)));
				ret.push(m);
				holder = holder.substr(holder.indexOf(m)+m.length);
				if (prevLast >= needle.lastIndex) {
					real.warn("[EV] Attempting to highlight matches for this regex will cause infinite loop, stopping")
					break;
				}
				prevLast = needle.lastIndex;
			}
			ret.push(holder);
		}
		return ret;
	}

	/** Contains regex/str searches for needles/blacklists **/
	class NeedleBundle {

		/**
		 * Hold user defined needles, string/regex, to search sinks for.
		 * @param {string[]} needleList Array of needles, as strings
		 * @example
		 * // Needle bundle for substring `asdf` and regex `/asdf/gi`
		 * const x = new NeedleBundle(["asdf", "/asdf/gi"]);
		 **/
		constructor(needleList) {
			this.needles = [];
			this.regNeedle = [];
			const test = /^\/(.*)\/(i|g|gi|ig)?$/;
			for (const need of needleList) {
				const s = test.exec(need);
				if (s) {
					const reg = new RegExp(s[1],
						s[2] === undefined? "": s[2]);
					this.regNeedle.push(reg);
				} else {
					this.needles.push(need);
				}
			}
		}

		*genStrMatches(str) {
			for (const need of this.needles) {
				if (str.includes(need)) {
					yield need;
				}
			}
		}

		*genRegMatches(str) {
			for (const need of this.regNeedle) {
				need.lastIndex = 0; // just to be sure there is no funny buisness
				if (need.test(str)) {
					need.lastIndex = 0; // This line is important b/c JS regex holds a state secretly :(
					yield need;
				}
			}
		}

		*genMatches(str) {
			for (const match of this.genStrMatches(str)) {
				yield match;
			}
			for (const match of this.genRegMatches(str)) {
				yield match;
			}
		}

		matchAny(str) {
			for (const match of this.genMatches(str)) {
				if (match) {
					return true;
				}
			}
			return false;
		}
	}

	/** Everything that might make a particular sink interesting */
	class SearchBundle {
		/**
		 * Contains qualifications for sink to be considered interesting
		 * @param {NeedleBundle}	needles Needles ie user provided string/regex
		 * @param {object}	fifoBank Maps source name to `SourceFifo`
		 **/
		constructor(needles, fifoBank) {
			this.needles = needles;
			this.fifoBank = fifoBank
		}

		*genSplits(str) {
			for (const match of this.needles.genStrMatches(str)) {
				yield {
					name: "needle", decode:"",
					search: match,
					split: strSpliter(str, match)
				};
			}
			for (const match of this.needles.genRegMatches(str)) {
				yield {
					name: "needle", decode:"",
					search: match,
					split: regexSpliter(str, match)
				};
			}

			for (const [key, fifo] of Object.entries(this.fifoBank)) {
				for (const match of fifo.genAllMatches(str)) {
					yield {
						name: key,
						split: strSpliter(str, match.search),
						...match,
					};
				}
			}
		}
	}

	// Start of transplanted decoder engine from original GitHub version
	function _isNeedleBad(str, fifo, BLACKLIST) {
		if (typeof(str) !== "string" || str.length == 0 || fifo.has(str)) {
			return true;
		}
		return BLACKLIST.matchAny(str);
	}

	function* _decodeAll(s, fifo, BLACKLIST, decoded = "") {
		if (_isNeedleBad(s, fifo, BLACKLIST)) {
			return;
		}
		yield [s, decoded];

		try {
			const dec = real.JSON.parse(s);
			if (dec) {
				const fwd = `\t{\n\t\tlet _ = ${s};\n\t\t_`;
				yield* _decodeAny(dec, fifo, BLACKLIST, `\t\tx = JSON.stringify(_);\n\t}\n${decoded}`, fwd);
				return;
			}
		} catch (_) {}

		let url = null;
		try {
			url = new URL(s);
			for (const [key, value] of getAllQueryParams(url.search)) {
				const dec = `\t{\n` + `\t\tconst _ = new URL("${s.replaceAll('"', "%22")}");\n` + `\t\t_.searchParams.set('${key.replaceAll('"', '\x22')}', decodeURIComponent(x));\n` + `\t\tx = _.href;\n` + `\t}\n` + decoded;
				yield* _decodeAll(value, fifo, BLACKLIST, dec);
			}
			if (url.hash.length > 1) {
				const dec = `\t{\n` + `\t\tconst _ = new URL("${s.replaceAll('"', "%22")}");\n` + `\t\t_.hash = x;\n` + `\t\tx = _.href;\n` + `\t}\n` + decoded;
				yield* _decodeAll(url.hash.substring(1), fifo, BLACKLIST, dec);
			}
		} catch (err) {}

		try {
			const dec = real.atob.call(window, s);
			if (dec) {
				yield* _decodeAll(dec, fifo, BLACKLIST, `\tx = btoa(x);\n${decoded}`);
				return;
			}
		} catch (_) {}

		const decReplace = s.replaceAll("+", " ");
		if (decReplace !== s) {
			yield* _decodeAll(decReplace, fifo, BLACKLIST, `\tx = x.replaceAll("+", " ");\n${decoded}`);
		}

		if (!s.includes("%")) {
			return;
		}

		try {
			const decComp = real.decodeURIComponent(s);
			if (decComp && decComp != s) {
				yield* _decodeAll(decComp, fifo, BLACKLIST, `\tx = encodeURIComponent(x);\n${decoded}`);
			}
		} catch (_) {}

		try {
			const decUri = real.decodeURI(s);
			if (decUri && decUri != s) {
				yield* _decodeAll(decUri, fifo, BLACKLIST, `\tx = encodeURIComponent(x);\n${decoded}`);
			}
		} catch (_) {}
	}

	function* _decodeAny(any, fifo, BLACKLIST, decoded, fwd) {
		if (Array.isArray(any)) {
			yield* _decodeArray(any, fifo, BLACKLIST, decoded, fwd);
		} else if (typeof(any) == "object" && any !== null) {
			yield* _decodeObject(any, fifo, BLACKLIST, decoded, fwd);
		} else {
			yield* _decodeAll(any, fifo, BLACKLIST, fwd + "= x;\n" + decoded);
		}
	}

	function* _decodeArray(a, fifo, BLACKLIST, decoded, fwd) {
		for (const i in a) {
			yield* _decodeAny(a[i], fifo, BLACKLIST, decoded, fwd + `[${i}]`);
		}
	}

	function* _decodeObject(o, fifo, BLACKLIST, decoded, fwd) {
		for (const prop in o) {
			yield* _decodeAny(o[prop], fifo, BLACKLIST, decoded, fwd + `[${JSON.stringify(prop)}]`);
		}
	}

	function* deepDecode(s, fifo, BLACKLIST) {
		if (typeof(s) === 'string') {
			yield* _decodeAll(s, fifo, BLACKLIST);
		} else if (typeof(s) === "object" && s !== null) {
			const fwd = `\t{\n\t\tlet _ = ${JSON.stringify(s)};\n\t\t_`;
			yield* _decodeAny(s, fifo, BLACKLIST, `\t\tx = _\n\t}\n`, fwd);
		}
	}
	// End of transplanted decoder engine

	// End of transplanted decoder engine

	function storeSourceForProbe(sObj, fifoName) {
		let encoder = null;
		let priority = 1;
		let id = '';
		const param = sObj.param;

		switch (fifoName) {
			case 'localStorage':
				if (!param) break;
				id = `ls:${param}`;
				priority = 1;
				encoder = (marker) => { localStorage.setItem(param, marker); };
				break;
			case 'cookie':
				if (!param) break;
				id = `cookie:${param}`;
				priority = 1;
				encoder = (marker) => { document.cookie = `${param}=${marker}`; };
				break;
			case 'winname':
				id = 'winname';
				priority = 1;
				encoder = (marker) => { window.name = marker; };
				break;
			case 'query':
				if (!param) break;
				id = `query:${param}`;
				priority = 3;
				encoder = (marker) => {
					const url = new URL(window.location.href);
					url.searchParams.set(param, marker);
					window.location.href = url.href;
				};
				break;
			case 'fragment':
				id = 'fragment';
				priority = 3;
				encoder = (marker) => { window.location.hash = marker; };
				break;
			case 'path':
				// Path manipulation is complex and risky, skipping for probe for now.
				break;
		}

		if (encoder) {
			window.EV_FOUND_SOURCES.push({
				id,
				priority,
				encoder,
				value: sObj.search,
				meta: { type: fifoName, param: param, location: location.href }
			});
		}
	}


	const MAX_INPUT_SIZE = 10000;

	let rotateWarnAt = 8;
	function addToFifo(sObj, fifoName) {
		if (typeof sObj.search === 'string' && sObj.search.length > MAX_INPUT_SIZE) {
			return;
		}

		// Store the original source for the probe feature before decoding/blacklisting.
		storeSourceForProbe(sObj, fifoName);

		const fifo = ALLSOURCES[fifoName];
		if (!fifo) {
			throw `No ${fifoName}`;
		}

		for (const [search, decode] of deepDecode(sObj.search, fifo, BLACKLIST)) {
			const throwaway = fifo.nq({...sObj, search: search, decode: decode});

			if (throwaway % rotateWarnAt == 1) {
				rotateWarnAt *= 2;
				const intCol = CONFIG.formats.interesting;
				real.log(`%c[EV INFO]%c '${CONFIG.formats[fifoName].pretty}' fifo limit (${fifo.limit}) exceeded. EV has rotated out ${throwaway} items so far. From url: %c${location.href}`,
					intCol.highlight, intCol.default, intCol.highlight
				);
			}
		}
	}

	/**
	* Helper function to turn parsable arguments into nice strings
	* @arg {Object|string} arg Argument to be turned into a string
	**/
	function argToString(arg) {
		if (typeof(arg) === "string")
			return arg
		if (typeof(arg) === "object")
			return real.JSON.stringify(arg)
		return arg.toString();
	}

	/**
	* Returns the type of an argument. Returns null if the argument should be
	* skipped.
	* @arg arg Argument to have it's type checked
	*/
	function typeCheck(arg) {
		const knownTypes = [
			"function", "string", "number", "object", "undefined", "boolean",
			"symbol"
		];
		const t = typeof(arg);

		// sanity
		if (!knownTypes.includes(t)) {
			throw `Unexpect argument type ${t} for ${arg}`;
		}

		// configured to not check
		if (!CONFIG.types.includes(t)) {
			return null;
		}

		return t;
	}

	/**
	* Turn all arguments into strings and change record original type
	*
	* @args {Object} args `arugments` object of hooked function
	*/
	function getArgs(args) {
		const ret = [];

		if (typeof(arguments[Symbol.iterator]) !== "function") {
			throw "Aguments can't be iterated over."
		}

		for (const i in args) {
			if (!args.hasOwnProperty(i)) continue;
			const t = typeCheck(args[i]);
			if (t === null) continue;
			const ar = {
				"type": t,
				"str": argToString(args[i]),
				"num": +i,
			}
			if (t !== "string") {
				ar["orig"] = args[i];
			}
			ret.push(ar);
		}
		return {"args" : ret, "len" : args.length};
	}

	function printTitle(name, format, num) {
		let titleGrp = "%c[EV] %c%s%c %s"
		let func = real.logGroup;
		const values = [
			format.default, format.highlight, name, format.default, location.href
		];

		if (!format.open) {
			func = real.logGroupCollapsed;
		}
		if (num >1) {
			// add arg number in format
			titleGrp = "%c[EV] %c%s[%d]%c %s"
			values.splice(3,0,num);
		}
		func(titleGrp, ...values)
		return titleGrp;
	}

	/**
	* Print all the arguments to the hooked funciton
	*
	* @argObj {Array} args array of arguments
	**/
	function printArgs(argObj) {
		const argFormat = CONFIG.formats.args;
		if (!argFormat.use) return;
		const func = argFormat.open ? real.logGroup : real.logGroupCollapsed;

		function printFuncAlso(arg) {
			if (arg.type === "function" && arg.orig) {
				real.log(arg.orig);
			}
		}

		if (argObj.len === 1 && argObj.args.length == 1) {
			const arg = argObj.args[0];
			const argTitle ="%carg(%s):";
			const data = [
				argFormat.default,
				arg.type,
			];
			func(argTitle, ...data);
			real.log("%c%s", argFormat.highlight, arg.str);
			printFuncAlso(arg);
			real.logGroupEnd(argTitle);
			return
		}

		const argTitle = "%carg[%d/%d](%s): "
		const total = argObj.len;
		for (const i of argObj.args) {
			func(argTitle, argFormat.default, i.num + 1, total, i.type);
			real.log("%c%s", argFormat.highlight, i.str);
			printFuncAlso(i);
			real.logGroupEnd(argTitle);
		}
	}

	function zebraBuild(arr, fmts) { // fmt2 is used via arguments
		const fmt = "%c%s".repeat(arr.length);
		const args = [];
		for (let i=0; i<arr.length; i++) {
			args.push(fmts[i % 2]);
			args.push(arr[i]);
		}
		args.unshift(fmt);
		return args;
	}

	function zebraLog(arr, fmt) {
		real.log(...zebraBuild(arr, [fmt.default, fmt.highlight]));
	}

	function zebraGroup(arr, fmt) {
		const a = zebraBuild(arr, [fmt.default, fmt.highlight]);
		if (fmt.open) {
			real.logGroup(...a);
		} else {
			real.logGroupCollapsed(...a);
		}
		return a[0];
	}

	/**
	* Check interest and get printers for each interesting result
	*
	* @argObj {Array} args array of arguments
	**/
	function getInterest(argObj, intrBundle) {

		function printer(s, arg) {
			const fmt = CONFIG.formats[s.name];
			const display = s.display? s.display: s.name;
			let word = s.search;
			let dots = "";
			if (word.length > 80) {
				dots = "..."
				word = s.search.substr(0, 77);
			}
			const title = [
				s.param? `${display}[${s.param}]: ` :`${display}: `, word
			];
			if (argObj.len > 1) {
				title.push(`${dots} found (arg:`, arg.num, ")");
			} else {
				title.push(`${dots} found`);
			}
			if (s.decode) {
				title.push(" [Decoded]");
			}

			const end = zebraGroup(title, fmt);
			if (dots) {
				const d = "Entire needle:"
				real.logGroupCollapsed(d);
				real.log(s.search);
				real.logGroupEnd(d);
			}
			if (s.decode) { // TODO probably should be moved to the recursve decoder area
				const d = "Encoder function:";
				real.logGroupCollapsed(d);
				let add = "\t";
				let pmtwo = false;
				switch (s.name) { // TODO: this should be moved to interestBundle, I think
				case "path":
					if (!s.param) break;
					add += `if (y) {\n\t\t`
					add += `const pth = document.location.pathname.substring(1).split('/');\n\t\t`;
					add += `pth[${s.param}] = x;\n\t\t`;
					add += `document.location.pathname = '/' + pth.join('/');\n\t`;
					add += `}\n\t`
					pmtwo = true;
					break;
				case "localStore":
					if (!s.param) break;
					add += `if (y) localStorage.setItem("${s.param}", x);\n\t`;
					pmtwo = true;
					break;
				case "query":
					if (!s.param) break;
					add +=  `const _ = new URL(window.location.href);\n\t`
					add += `// next line might need some changes\n\t`;
					add += `_.searchParams.set('${s.param.replaceAll('"', '\x22')}', decodeURIComponent(x));\n\t`;
					add += `x = _.href;\n\t`;
					add += `if (y) window.location = x;\n\t`
					pmtwo = true;
					break;
				case "winname":
					add +=  `if (y) window.name = x;\n\t`
					pmtwo = true;
					break;
				}

				real.log(`encoder = ${pmtwo ? "(x, y)" : "x"} => {\n${s.decode}${add}return x;\n}//`);
				real.logGroupEnd(d);
			}
			zebraLog(s.split, fmt);
			real.logGroupEnd(end);
		}

		// update changing lists
		addChangingSearch();

		const ret = [];

		for (const arg of argObj.args) {
			for (const match of intrBundle.genSplits(arg.str)) {
				ret.push(() => printer(match, arg));
			}
		}

		return ret;
	}

	/**
	* Parse all arguments for function `name` and pretty print them in the console
	* @param {SearchBundle}	intrBundle Used to check if a call is interesting
	* @param {string}	name Name of function that is being hooked
	* @param {array}	args array of arguments
	* @returns {boolean} Always returns `false`
	**/
	function finalizeLog(logCandidate) {
		const { intrBundle, name, args, fmts, argObj } = logCandidate;

		const printers = getInterest(argObj, intrBundle);
		let format = null;

		if (printers.length > 0) {
			format = fmts.interesting;
			if (!format.use) return;
		} else {
			format = fmts.title;
			if (!format.use) return;
		}

		const titleGrp = printTitle(name, format, argObj.len);
		printArgs(argObj);
		printers.forEach(p => p());

		const stackFormat = CONFIG.formats.stack;
		if (stackFormat.use) {
			const stackTitle = "%cstack: ";
			if (stackFormat.open) {
				real.logGroup(stackTitle, stackFormat.default);
			} else {
				real.logGroupCollapsed(stackTitle, stackFormat.default);
			}
			real.trace();
			real.logGroupEnd(stackTitle);
		}
		real.logGroupEnd(titleGrp);
	}

	function EvalVillainHook(intrBundle, name, args, thisArg, originalFunc) {
		const VERIFIABLE_SINKS = ['set(Element.innerHTML)', 'set(Element.outerHTML)', 'value(Element.setAttribute)'];

		// For now, only apply verification to a subset of sinks.
		if (VERIFIABLE_SINKS.includes(name)) {
			const markerId = `__EV_MARKER_${Date.now()}_${Math.random().toString(36).substr(2, 8)}__`;
			const originalArgs = [...args];
			let taintedArgIndex = -1;

			if (name === 'value(Element.setAttribute)') {
				taintedArgIndex = 1;
			} else { // innerHTML, outerHTML
				taintedArgIndex = 0;
			}

			if (typeof args[taintedArgIndex] === 'string') {
				args[taintedArgIndex] += markerId;
			}

			try {
				originalFunc.apply(thisArg, args);
			} catch (e) {
				// If it fails, log the original call without verification.
				console.warn("[EV] Original sink call failed during verification attempt.", e);
				return false; // Let the default logger handle it.
			}

			queueMicrotask(() => {
				let verified = false;
				try {
					switch (name) {
						case 'value(Element.setAttribute)':
							if (thisArg && typeof thisArg.getAttribute === 'function' && thisArg.getAttribute(originalArgs[0])?.includes(markerId)) {
								verified = true;
							}
							break;
						case 'set(Element.innerHTML)':
							if (thisArg && thisArg.innerHTML.includes(markerId)) {
								verified = true;
							}
							break;
						case 'set(Element.outerHTML)':
							// After outerHTML, the original element reference is gone. Check the parent.
							if (thisArg && thisArg.parentElement && thisArg.parentElement.innerHTML.includes(markerId)) {
								verified = true;
							}
							break;
					}
				} catch (e) {
					// Fallback for safety, e.g., if element was removed from DOM.
					if (document.documentElement.innerHTML.includes(markerId)) {
						verified = true;
						console.warn("[EV] Verification fell back to document search for sink:", name);
					}
				}

				if (verified) {
					const argObj = getArgs(originalArgs);
					if (argObj.args.length > 0) {
						finalizeLog({
							intrBundle, name, args: originalArgs, fmts: CONFIG.formats, argObj
						});
					}
				}
			});

			return true; // We handled the call.
		}

		// --- Default logging for non-verifiable sinks ---
		const argObj = getArgs(args);
		if (argObj.args.length > 0) {
			finalizeLog({ intrBundle, name, args, fmts: CONFIG.formats, argObj });
		}

		return false; // We did not handle the call, let the proxy do it.
	}

	class evProxy {
		constructor(intr) {
			self.intr = intr;
		}

		// Start of Eval Villain hook
		apply(_target, _thisArg, args) {
			const handled = EvalVillainHook(self.intr, this.evname, args, _thisArg, _target);
			if (!handled) {
				return Reflect.apply(...arguments);
			}
		}

		// Start of Eval Villain hook
		construct(_target, args, _newArg) {
			const handled = EvalVillainHook(self.intr, this.evname, args, _newArg, _target);
			if (!handled) {
				return Reflect.construct(...arguments);
			}
		}
	}

	/**
	 * Safely search for a property descriptor up the prototype chain.
	 * @param {object} obj The object to search on.
	 * @param {string} propName The name of the property.
	 * @returns {object|null} The property descriptor or null if not found.
	 */
	function findDescriptor(obj, propName) {
		let current = obj;
		while (current) {
			const descriptor = Object.getOwnPropertyDescriptor(current, propName);
			if (descriptor) {
				return descriptor;
			}
			current = Object.getPrototypeOf(current);
		}
		return null;
	}

	/*
	 * NOTICE:
	 * updates here should maybe be reflected in input validation
	 * file: /pages/config/config.js
	 * function: validateFunctionsPattern
	*/
	/**
	 * Accepts sink name, such as `document.write` or `value(URLSearchParams.get)` and replaces the sink with a proxy (`evProxy`).
	 * @param {string} evname	Name of sink to hook.
	 **/
	function applyEvalVillain(evname) {
		try {
			function getFunc(n) {
				const ret = {};
				ret.where = window;
				const groups = n.split(".");
				let i = 0;
				for (i = 0; i < groups.length - 1; i++) {
					if (!ret.where) {
						return null;
					}
					ret.where = ret.where[groups[i]];
				}
				ret.leaf = groups[i];
				if (!ret.where) {
					return null;
				}
				return ret;
			}

			const ownprop = /^(set|value)\(([a-zA-Z_$.]+)\)\s*$/.exec(evname);
			const ep = new evProxy(INTRBUNDLE);
			ep.evname = evname;

			if (ownprop) {
				const prop = ownprop[1]; // 'set' or 'value'
				const f = getFunc(ownprop[2]);

				if (!f) {
					real.warn(`[EV] Could not find object for sink: ${evname}`);
					return;
				}

				const descriptor = findDescriptor(f.where.prototype, f.leaf);

				if (!descriptor) {
					real.warn(`[EV] Could not find property descriptor for sink: ${evname}`);
					return;
				}

				const orig = descriptor[prop];
				if (typeof orig !== 'function') {
					real.warn(`[EV] Original property '${prop}' is not a function for sink: ${evname}`);
					return;
				}

				Object.defineProperty(f.where.prototype, f.leaf, { [prop]: new Proxy(orig, ep) });

			} else if (!/^[a-zA-Z_$.]+$/.test(evname)) {
				real.warn("[EV] Sink name: %s invalid, not hooking", evname);

			} else {
				const f = getFunc(evname);
				if (!f || typeof f.where[f.leaf] !== 'function') {
					real.warn(`[EV] Could not find function for sink: ${evname}`);
					return;
				}
				f.where[f.leaf] = new Proxy(f.where[f.leaf], ep);
			}
		} catch (e) {
			real.warn(`[EV] Failed to hook sink: ${evname}`, e);
		}
	}

	/**
	 * Some sources can change without reloading the page, so EV checks for
	 * them every time. This is should be relativly fast. If they are seen
	 * before, they should not go through deep decoding loop.
	 */
	function addChangingSearch() {
		// window.name
		if (ALLSOURCES.winname) {
			addToFifo({
				display: "window.name",
				search: window.name,
			}, "winname");
		}

		if (ALLSOURCES.fragment) {
			addToFifo({
				search: location.hash.substring(1),
			}, "fragment");
		}

		if (ALLSOURCES.query) {
			const srch = window.location.search;
			if (srch.length > 1) {
				for (const [key, value] of getAllQueryParams(srch)) {
					addToFifo({
						param: key,
						search: value
					}, "query");
				}
			}
		}

		if (ALLSOURCES.path) {
			const pth = location.pathname;
			if (pth.length >= 1) {
				addToFifo({search: pth}, "path");
				pth.substring(1)
					.split('/').forEach((elm, index) => {
						addToFifo({
							param: ""+index,
							search: elm
						}, "path");
				});
			}
		}
	}


	/**
	 * Parses initial values contained in sources and updates fifos with them.
	 **/
	function buildSearches() {
		const {formats} = CONFIG;

		function putInUse(nm) {
			if (formats[nm] && formats[nm].use) {
				ALLSOURCES[nm] = new SourceFifo(formats[nm].limit);
				return true;
			}
			return false;
		}

		// Load persisted user sources
		if (putInUse("userSource")) {
			try {
				const savedSearches = JSON.parse(real.localStorage.getItem(USER_SOURCE_KEY) || '[]');
				savedSearches.forEach(searchString => {
					if (!ALLSOURCES.userSource.has(searchString)) {
						const sObj = { search: searchString, display: 'localStorage' };
						addToFifo(sObj, "userSource");
					}
				});
			} catch (e) {
				real.warn('[EV] Failed to load user sources from localStorage.', e);
			}
		}

		// referer
		let nm = "referrer";
		if (putInUse(nm) && document.referrer) {
			const url = new URL(document.referrer);
			// don't show if referer is just https://example.com/ and we are on an example.com domain
			if (url.search != location.search || url.search && url.pathname !== "/" && url.hostname !== location.hostname) {
				addToFifo({
					search: document.referrer
				}, nm);
			}
		}

		// cookies
		nm = "cookie";
		if (putInUse(nm)) {
			for (const i of document.cookie.split(/;\s*/)) {
				const s = i.split("=");
				if (s.length >= 2) {
					addToFifo({
						param: s[0],
						search: s[1],
					}, nm);
				} else {
					addToFifo({
						search: s[0],
					}, nm);
				}
			}
		}

		nm = "localStore"
		if (putInUse(nm)){
			const l = real.localStorage.length;
			for (let i=0; i<l; i++) {
				const key = real.localStorage.key(i);
				addToFifo({
					display: "localStorage",
					param: key,
					search: real.localStorage.getItem(key),
				}, nm);
			}
		}


		// TODO seems repeated
		putInUse("winname")
		putInUse("fragment");
		putInUse("path");
		putInUse("query");
		addChangingSearch();
	}

	// prove we loaded
	if (CONFIG.checkId) {
		document.currentScript.setAttribute(CONFIG.checkId, true);
		delete CONFIG["checkId"];
	}

	// grab real functions before hooking
	const real = {
		log : console.log,
		debug : console.debug,
		warn : console.warn,
		dir : console.dir,
		error : console.error,
		logGroup : console.group,
		logGroupEnd : console.groupEnd,
		logGroupCollapsed : console.groupCollapsed,
		trace : console.trace,
		JSON : JSON,
		localStorage: localStorage,
		decodeURIComponent : decodeURIComponent,
		decodeURI : decodeURI,
		atob: atob,
	}

	const BLACKLIST = new NeedleBundle(CONFIG.blacklist);
	delete CONFIG.blacklist;
	const INTRBUNDLE = new SearchBundle(
		new NeedleBundle(CONFIG.needles),
		ALLSOURCES
	);
	delete CONFIG.needles;

	buildSearches();

	for (const nm of CONFIG["functions"]) {
		try {
			applyEvalVillain(nm);
		} catch (e) {
			real.warn(`[EV] Uncaught error while hooking sink: ${nm}`, e);
		}
	}

	// turns console.log into console.info
	if (CONFIG.formats.logReroute.use) {
		console.log = console.info;
	}

	if (CONFIG.sinker) {
		window[CONFIG.sinker] = (x,y) => EvalVillainHook(INTRBUNDLE, x, y);
		delete CONFIG.sinker;
	}

	if (CONFIG.sourcer) {
		const fmt = CONFIG.formats.userSource;
		if (fmt.use) {
			const srcer = CONFIG.sourcer;
			ALLSOURCES.userSource = new SourceFifo(fmt.limit);
			window[srcer] = (src_name, src_val, debug=false) => {
				// ex: evSourcer("Response from fetch", resp.json(), true)
				// debug=true results in a console.debug for each source injested
				if (debug) {
					const o = typeof(src_val) === 'string'? src_val: real.JSON.stringify(src_val);
					real.debug(`[EV] ${srcer}[${src_name}] from ${document.location.origin}  added:\n ${o}`);
				}
				addToFifo({
					display: `${srcer}[${src_name}]`,
					search: src_val,
					}, "userSource");
				return false;
			}
			delete CONFIG.sourcer;
		}
	}

	real.log("%c[EV]%c Functions hooked for %c%s%c",
		CONFIG.formats.interesting.highlight,
		CONFIG.formats.interesting.default,
		CONFIG.formats.interesting.highlight,
		document.location.origin,
		CONFIG.formats.interesting.default
	);
}
