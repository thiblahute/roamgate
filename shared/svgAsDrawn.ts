/**
 * An SVG's markup as it is drawn now: what its animations set is written
 * into a copy, and the animations left out, so a picture of it is this
 * moment and not the start.
 *
 * Self-contained: the page's helper script embeds this function's source
 * (server/src/http/rendered-helper.ts). No imports, no module state.
 */
export function svgAsDrawn(svg: SVGSVGElement): string {
  const smil = "animate, animateTransform, animateMotion, set";
  // A paused SVG inserted by a script may not have been sampled yet.
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
    // An image of it no longer has the page's styles and fonts.
    "color",
    "font-family",
    "font-size",
    "font-weight",
  ];
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const live = [svg as Element, ...svg.querySelectorAll("*")];
  const copies = [clone as Element, ...clone.querySelectorAll("*")];
  live.forEach((element, index) => {
    const copy = copies[index];
    if (!copy || element.matches(smil) || element.closest("style")) return;
    const computed = getComputedStyle(element);
    const moved = element.querySelector(
      ":scope > animateTransform, :scope > animateMotion",
    );
    const rules = styles
      // The attribute written below holds an animated transform.
      .filter((name) => !(moved && name === "transform"))
      .map((name) => `${name}:${computed.getPropertyValue(name)}`)
      .filter((rule) => !rule.endsWith(":"));
    // A copy's CSS animations would start over and override all of this.
    rules.push("animation:none", "transition:none");
    copy.setAttribute(
      "style",
      `${copy.getAttribute("style") ?? ""};${rules.join(";")}`,
    );
    for (const animation of element.querySelectorAll(
      ":scope > animate, :scope > set",
    )) {
      const name = animation.getAttribute("attributeName");
      if (!name || /^on|href$/i.test(name)) continue;
      const property = (element as unknown as Record<string, unknown>)[name] as
        | { animVal?: { valueAsString?: string; value?: unknown } }
        | undefined;
      const current = property?.animVal;
      const text =
        current?.valueAsString ??
        (typeof current?.value === "number" ||
        typeof current?.value === "string"
          ? String(current.value)
          : computed.getPropertyValue(name) || undefined);
      if (text !== undefined) copy.setAttribute(name, text);
    }
    if (moved && element instanceof SVGGraphicsElement) {
      const own = element.getCTM();
      const parent =
        element.parentElement instanceof SVGGraphicsElement
          ? element.parentElement.getCTM()
          : null;
      const matrix = own && parent ? parent.inverse().multiply(own) : own;
      if (matrix)
        copy.setAttribute(
          "transform",
          `matrix(${matrix.a} ${matrix.b} ${matrix.c} ${matrix.d} ${matrix.e} ${matrix.f})`,
        );
    }
  });
  for (const animation of clone.querySelectorAll(smil)) animation.remove();
  const box = svg.getBoundingClientRect();
  clone.setAttribute("width", String(box.width));
  clone.setAttribute("height", String(box.height));
  if (!clone.getAttribute("xmlns"))
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  return new XMLSerializer().serializeToString(clone);
}
