/*
 * Where a reading stops: before a references section, which Readability counts in the article (2026-10-29, the user
 * confirmed these names — PC app requests 115d2495, fb1fd2d7). Shared by following on from a selection (js/page-ui.js
 * stopAtNotes) and whole-page reading (js/content/html-doc.js), put in the page before them (js/events.js
 * captureSelection, js/content.js getRequireJs).
 * A heading's name is compared whole, case aside: its spaces, its [edit] marks, its numbering ("5. References") and
 * colons left out.
 */
var readAloudStopHeadings = (function() {
  var NAMES = [
    "참고 문헌", "References", "외부 링크", "각주",
    "같이 보기", "함께 보기", "관련 항목", "주석", "출처", "참고 자료", "더 읽을거리",
    "See also", "Notes", "Footnotes", "Citations", "Sources", "Bibliography", "Further reading", "External links", "Works cited",
  ];
  var KEYS = new Set(NAMES.map(key));

  function key(text) {
    return String(text).replace(/\[[^\]]*\]/g, "").replace(/^[\s\d.]+/, "").replace(/[\s:：]+/g, "").toLowerCase();
  }

  function isStop(text) {
    return KEYS.has(key(text));
  }

  //the first heading (h1-h6) named so after a point of the page — before end ({node, offset}) when it's given — or
  //null. None when the point is in such a section already: the latest heading before it at its level or above is
  //one (an h3 under References too)
  function after(node, offset, root, end) {
    var span = document.createRange();
    span.setStart(node, offset);
    if (end) span.setEnd(end.node, end.offset);
    var levels = [];
    var headings = root.querySelectorAll("h1, h2, h3, h4, h5, h6");
    for (var i = 0; i < headings.length; i++) {
      var heading = headings[i];
      var level = Number(heading.tagName[1]);
      var stop = isStop(heading.textContent);
      var where = span.comparePoint(heading, 0);
      if (where < 0) {
        levels[level] = stop;
        levels.length = level + 1;
        continue;
      }
      if (end && where > 0) return null;
      if (levels.some(Boolean)) return null;
      if (stop) return heading;
    }
    return null;
  }

  return {names: NAMES, key: key, isStop: isStop, after: after};
})();
