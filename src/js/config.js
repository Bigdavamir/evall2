const config = {
    "formats": {
        "title": { "pretty": "Normal Results", "use": false, "open": false, "default": "color: none", "highlight": "color: #088" },
        "interesting": { "pretty": "Interesting Results", "use": true, "open": true, "default": "color: red", "highlight": "color: #088" },
        "args": { "pretty": "Args Display", "use": true, "open": false, "default": "color: none", "highlight": "color: #088" },
        "needle": { "pretty": "Needles Search", "use": true, "open": true, "default": "color: none", "highlight": "color: #088" },
        "query": { "pretty": "Query Search", "limit": 200, "use": true, "open": true, "default": "color: none", "highlight": "color: #088" },
        "fragment": { "pretty": "Fragment Search", "limit": 64, "use": true, "open": true, "default": "color: none", "highlight": "color: #088" },
        "winname": { "pretty": "window.name Search", "limit": 200, "use": true, "open": true, "default": "color: none", "highlight": "color: #088" },
        "path": { "pretty": "Path Search", "limit": 32, "use": false, "open": true, "default": "color: none", "highlight": "color: #088" },
        "referrer": { "pretty": "Referrer Search", "limit": 32, "use": false, "open": true, "default": "color: none", "highlight": "color: #088" },
        "cookie": { "pretty": "Cookie Search", "limit": 32, "use": true, "open": false, "default": "color: none", "highlight": "color: yellow" },
        "localStore": { "pretty": "localStorage", "limit": 100, "use": true, "open": false, "default": "color: none", "highlight": "color: yellow" },
        "userSource": { "pretty": "User Sources", "limit": 100, "use": true, "open": false, "default": "color: none", "highlight": "color:#147599" },
        "stack": { "pretty": "Stack Display", "use": true, "open": false, "default": "color: none", "highlight": "color: #088" },
        "logReroute": { "pretty": "Log Reroute", "use": true, "open": null, "default": "N/A", "highlight": "N/A" }
    },
    "needles": ["asdf"],
    "blacklist": ["/^\\s*\\S{0,3}\\s*$/", "/^\\s*(?:true|false)\\s*$/gi"],
    "functions": [
        "eval", "Function", "set(Element.innerHTML)", "set(Element.outerHTML)",
        "value(Range.createContextualFragment)", "document.write", "document.writeln",
        "set(Node.textContent)", "set(HTMLElement.innerText)", "value(Element.setAttribute)",
        "value(Element.setAttributeNS)", "set(CSSStyleDeclaration.cssText)", "set(Location.href)",
        "value(Location.assign)", "value(Location.replace)", "set(HTMLIFrameElement.src)",
        "set(HTMLIFrameElement.srcdoc)", "window.open", "Worker", "SharedWorker",
        "setTimeout", "setInterval", "window.addEventListener", "fetch",
        "value(XMLHttpRequest.open)", "value(Node.insertBefore)", "value(Node.appendChild)",
        "value(Node.replaceChild)"
    ],
    "types": ["string"]
};
