// One small map API over two engines: Google Maps (with live traffic) or Leaflet + OpenStreetMap.
// The app only talks to the object returned by createMap(), never to Leaflet or Google directly.
//
// createMap(el, { center:[lat,lng], zoom, googleKey, language, dark }) -> Promise<map>
//   map.kind                      "google" | "osm"
//   map.marker(opts)              opts: { lat, lng, html, cls, w, h, ax, ay, z, title, popup:()=>html, draggable }
//                                 -> { show(), hide(), remove(), open(), getLatLng(), setLatLng(ll), data }
//   map.getBounds().contains([lat,lng])
//   map.getZoom()
//   map.flyTo([lat,lng], zoom, done?)
//   map.flyToBounds([[lat,lng], ...], { padding, maxZoom })
//   map.panTo({lat,lng})
//   map.closePopup()
//   map.on("click" | "moveend" | "zoomend", fn)   click gets {lat,lng}
//   map.addControl(element)       top-right corner
//   map.setTraffic(on)            Google only

(function () {
  "use strict";

  // ---------------- Leaflet / OpenStreetMap ----------------
  function createLeaflet(el, o) {
    const lm = L.map(el, { zoomControl: true }).setView(o.center, o.zoom);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      className: o.dark ? "tiles-dark" : "",
    }).addTo(lm);
    addEventListener("load", () => lm.invalidateSize());

    const Ctl = L.Control.extend({
      initialize(elm) { this.elm = elm; },
      onAdd() { L.DomEvent.disableClickPropagation(this.elm); return this.elm; },
    });

    return {
      kind: "osm",
      marker(m) {
        const lk = L.marker([m.lat, m.lng], {
          icon: L.divIcon({ className: "mk " + (m.cls || ""), html: m.html || "", iconSize: [m.w, m.h],
            iconAnchor: [m.ax ?? m.w / 2, m.ay ?? m.h / 2], popupAnchor: [0, -(m.ay ?? m.h / 2)] }),
          zIndexOffset: m.z || 0, title: m.title || "", draggable: !!m.draggable, riseOnHover: true, keyboard: !!m.popup,
        });
        if (m.popup) lk.bindPopup(m.popup, { maxWidth: 300 });
        return {
          data: m.data,
          show() { if (!lm.hasLayer(lk)) lk.addTo(lm); },
          hide() { if (lm.hasLayer(lk)) lk.remove(); },
          remove() { lk.remove(); },
          open() { lk.openPopup(); },
          getLatLng() { const p = lk.getLatLng(); return { lat: p.lat, lng: p.lng }; },
          setLatLng(ll) { lk.setLatLng([ll.lat, ll.lng]); },
        };
      },
      getBounds() { const b = lm.getBounds(); return { contains: (p) => b.contains(p) }; },
      getZoom: () => lm.getZoom(),
      flyTo(ll, z, done) { if (done) lm.once("moveend", done); lm.flyTo(ll, z); },
      flyToBounds(pts, opt = {}) {
        lm.flyToBounds(pts, { padding: opt.padding ? [opt.padding, opt.padding] : undefined, maxZoom: opt.maxZoom });
      },
      panTo(ll) { lm.panTo([ll.lat, ll.lng]); },
      closePopup() { lm.closePopup(); },
      on(evt, fn) {
        if (evt === "click") lm.on("click", (e) => fn({ lat: e.latlng.lat, lng: e.latlng.lng }));
        else lm.on(evt, () => fn());
      },
      addControl(elm) { new Ctl(elm, { position: "topright" }).addTo(lm); },
      setTraffic() {},
    };
  }

  // ---------------- Google Maps ----------------
  function loadGoogle(key, language) {
    return new Promise((resolve, reject) => {
      const cb = "__twwGoogleReady";
      const timer = setTimeout(() => reject(new Error("Google Maps took too long to load")), 12000);
      window[cb] = () => { clearTimeout(timer); resolve(); };
      // Google calls this when the key is invalid, not allowed for this site, or billing is off
      window.gm_authFailure = () => {
        try { sessionStorage.setItem("tww-gfail", "1"); } catch {}
        location.reload();
      };
      const s = document.createElement("script");
      s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&callback=${cb}&loading=async&v=weekly&language=${language}&region=TH`;
      s.async = true;
      s.onerror = () => { clearTimeout(timer); reject(new Error("Could not load Google Maps")); };
      document.head.appendChild(s);
    });
  }

  function createGoogle(el, o) {
    const g = google.maps;
    const gm = new g.Map(el, {
      center: { lat: o.center[0], lng: o.center[1] },
      zoom: o.zoom,
      clickableIcons: false,
      gestureHandling: "greedy",
      mapTypeControl: false,
      streetViewControl: true,
      fullscreenControl: false,
    });
    const traffic = new g.TrafficLayer();
    const info = new g.InfoWindow({ maxWidth: 300 });

    // All HTML markers live in one overlay so panning stays smooth with ~1,000 markers.
    const items = new Set();
    class HtmlLayer extends g.OverlayView {
      onAdd() {
        this.box = document.createElement("div");
        this.box.style.position = "absolute";
        this.getPanes().overlayMouseTarget.appendChild(this.box);
        items.forEach((it) => it.shown && this.box.appendChild(it.div));
      }
      draw() { const p = this.getProjection(); if (p) items.forEach((it) => it.shown && place(it, p)); }
      onRemove() { this.box.remove(); }
    }
    const layer = new HtmlLayer();
    layer.setMap(gm);
    function place(it, proj) {
      const pt = (proj || layer.getProjection()).fromLatLngToDivPixel(it.ll);
      if (pt) it.div.style.transform = `translate(${Math.round(pt.x - it.ax)}px, ${Math.round(pt.y - it.ay)}px)`;
    }

    return {
      kind: "google",
      marker(m) {
        const div = document.createElement("div");
        div.className = "mk gmk " + (m.cls || "");
        div.innerHTML = m.html || "";
        Object.assign(div.style, { position: "absolute", left: 0, top: 0, width: m.w + "px", height: m.h + "px", zIndex: 1000 + (m.z || 0) });
        if (m.title) div.title = m.title;
        const it = { div, ll: new g.LatLng(m.lat, m.lng), ax: m.ax ?? m.w / 2, ay: m.ay ?? m.h / 2, shown: false };
        const open = () => {
          if (!m.popup) return;
          info.setContent(`<div class="gpop">${m.popup()}</div>`);
          info.setOptions({ pixelOffset: new g.Size(0, -it.ay) });
          info.setPosition(it.ll);
          info.open({ map: gm });
        };
        if (m.popup) {
          div.style.cursor = "pointer";
          div.tabIndex = 0;
          div.addEventListener("click", (e) => { e.stopPropagation(); open(); });
          div.addEventListener("keydown", (e) => { if (e.key === "Enter") open(); });
          g.OverlayView.preventMapHitsAndGesturesFrom(div);
        }
        items.add(it);
        return {
          data: m.data,
          show() {
            if (it.shown) return;
            it.shown = true;
            if (layer.box) { layer.box.appendChild(div); if (layer.getProjection()) place(it); }
          },
          hide() { if (!it.shown) return; it.shown = false; div.remove(); },
          remove() { this.hide(); items.delete(it); },
          open,
          getLatLng() { return { lat: it.ll.lat(), lng: it.ll.lng() }; },
          setLatLng(ll) { it.ll = new g.LatLng(ll.lat, ll.lng); if (it.shown && layer.getProjection()) place(it); },
        };
      },
      getBounds() {
        const b = gm.getBounds();
        return { contains: (p) => (b ? b.contains({ lat: p[0], lng: p[1] }) : true) };
      },
      getZoom: () => gm.getZoom(),
      flyTo(ll, z, done) {
        if (done) g.event.addListenerOnce(gm, "idle", done);
        gm.panTo({ lat: ll[0] ?? ll.lat, lng: ll[1] ?? ll.lng });
        gm.setZoom(z);
      },
      flyToBounds(pts, opt = {}) {
        const b = new g.LatLngBounds();
        pts.forEach((p) => b.extend({ lat: p[0], lng: p[1] }));
        gm.fitBounds(b, opt.padding || 0);
        if (opt.maxZoom) g.event.addListenerOnce(gm, "idle", () => { if (gm.getZoom() > opt.maxZoom) gm.setZoom(opt.maxZoom); });
      },
      panTo(ll) { gm.panTo(ll); },
      closePopup() { info.close(); },
      on(evt, fn) {
        if (evt === "click") gm.addListener("click", (e) => e.latLng && fn({ lat: e.latLng.lat(), lng: e.latLng.lng() }));
        else if (evt === "moveend") gm.addListener("idle", () => fn());
        else if (evt === "zoomend") gm.addListener("zoom_changed", () => fn());
      },
      addControl(elm) { elm.style.margin = "10px"; gm.controls[g.ControlPosition.TOP_RIGHT].push(elm); },
      setTraffic(on) { traffic.setMap(on ? gm : null); },
    };
  }

  window.createMap = async function (el, o) {
    let failed = false;
    try { failed = sessionStorage.getItem("tww-gfail") === "1"; } catch {}
    if (o.googleKey && !failed) {
      try {
        await loadGoogle(o.googleKey, o.language);
        return createGoogle(el, o);
      } catch (e) {
        console.warn("Falling back to OpenStreetMap:", e.message);
        try { sessionStorage.setItem("tww-gfail", "1"); } catch {}
        el.innerHTML = "";
      }
    }
    return createLeaflet(el, o);
  };
})();
