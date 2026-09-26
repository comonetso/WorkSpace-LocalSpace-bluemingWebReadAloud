
var readAloudDoc = new function() {
  var self = this;

  this.ignoreTags = "select, textarea, button, label, audio, video, dialog, embed, menu, nav, noframes, noscript, object, script, style, svg, aside, footer, #footer, .no-read-aloud, [aria-hidden=true]";

  //the whole article is returned at index 0, so its total length is known up front
  this.isSinglePage = true;

  //texts are one line each (getParas): read them like a selection — synthesized line by line,
  //short lines joined, a '.' at unpunctuated line ends (splitParagraphs in js/speech.js)
  this.splitParagraphs = true;

  this.getCurrentIndex = function() {
    return 0;
  }

  this.getTexts = async function(index) {
    if (index == 0) {
      const math = await getMath()
      try {
        if (math) math.show()
        return parse()
      }
      finally {
        if (math) math.hide()
      }
    }
    else return null;
  }

  this.getSelectedText = async function() {
    const math = await getMath()
    try {
      if (math) math.show()
      return window.getSelection().toString().trim()
    }
    finally {
      if (math) math.hide()
    }
  }



  function parse() {
    //find blocks containing text
    var start = new Date();
    //Reader-mode filter: blocks outside the article (comments, related-articles boxes) aren't read
    var article = findArticleElements();
    var textBlocks = keepArticleBlocks(findTextBlocks(50), article);
    var countChars = textBlocks.reduce(function(sum, elem) {return sum + getInnerText(elem).length}, 0);
    console.log("Found", textBlocks.length, "blocks", countChars, "chars in", new Date()-start, "ms");

    if (countChars < 1000) {
      textBlocks = keepArticleBlocks(findTextBlocks(3), article);
      var texts = textBlocks.map(getInnerText);
      console.log("Using lower threshold, found", textBlocks.length, "blocks", texts.join("").length, "chars");

      //trim the head and the tail
      var head, tail;
      for (var i=3; i<texts.length && !head; i++) {
        var dist = getGaussian(texts, 0, i);
        if (texts[i].length > dist.mean + 2*dist.stdev) head = i;
      }
      for (var i=texts.length-4; i>=0 && !tail; i--) {
        var dist = getGaussian(texts, i+1, texts.length);
        if (texts[i].length > dist.mean + 2*dist.stdev) tail = i+1;
      }
      if (head||tail) {
        textBlocks = textBlocks.slice(head||0, tail);
        console.log("Trimmed", head, tail);
      }
    }

    //mark the elements to be read
    var toRead = [];
    for (var i=0; i<textBlocks.length; i++) {
      toRead.push.apply(toRead, findHeadingsFor(textBlocks[i], textBlocks[i-1], article));
      toRead.push(textBlocks[i]);
    }
    $(toRead).addClass("read-aloud");   //for debugging only

    //extract texts, remembering which element each paragraph came from (page highlight)
    var paras = toRead.flatMap(getParas).filter(function(p) {return p.text});
    publishDocMap(paras);
    return paras.map(function(p) {return p.text});
  }

  /**
   * The elements of the page's article, found by Mozilla Readability (js/readability.js) on a copy
   * of the document. Returns {has(elem)} telling whether an element is in (or contains) the article,
   * or null when the library isn't loaded, the page doesn't look like an article, or parsing fails —
   * the caller then reads the page unfiltered, as before.
   */
  function findArticleElements() {
    try {
      if (typeof Readability == "undefined" || typeof isProbablyReaderable == "undefined") return null;
      if (!isProbablyReaderable(document)) return null;
      //number the copy's elements; the same positions in both walks pair copy and original
      var origEls = document.querySelectorAll("body *");
      var clone = document.cloneNode(true);
      var cloneEls = clone.querySelectorAll("body *");
      if (origEls.length != cloneEls.length) return null;
      for (var i=0; i<cloneEls.length; i++) cloneEls[i].setAttribute("data-readaloud-i", i);
      var result = new Readability(clone).parse();
      if (!result || !result.content) return null;
      var dom = new DOMParser().parseFromString(result.content, "text/html");
      var kept = new Set();
      dom.querySelectorAll("[data-readaloud-i]").forEach(function(el) {
        var orig = origEls[Number(el.getAttribute("data-readaloud-i"))];
        if (orig) kept.add(orig);
      });
      if (!kept.size) return null;
      //an ancestor of an article element contains article text (a list whose items survived)
      var ancestors = new Set();
      kept.forEach(function(el) {
        for (var p=el.parentElement; p && !ancestors.has(p); p=p.parentElement) ancestors.add(p);
      });
      console.log("Reader mode:", kept.size, "article elements");
      return {has: function(elem) {return kept.has(elem) || ancestors.has(elem)}};
    }
    catch (err) {
      console.warn("Reader-mode filter failed, reading unfiltered", err);
      return null;
    }
  }

  function keepArticleBlocks(blocks, article) {
    if (!article) return blocks;
    var kept = blocks.filter(article.has);
    //everything filtered out means the article wasn't what the blocks are: read unfiltered
    return kept.length ? kept : blocks;
  }

  //what the page highlight (js/page-ui.js) maps the reading position with: the extracted
  //paragraphs and the element each came from
  function publishDocMap(paras) {
    try {
      window.__readAloudHrgDocMap = {
        texts: paras.map(function(p) {return p.text}),
        elements: paras.map(function(p) {return p.elem}),
        //what getTexts() hides while extracting (dontRead): the highlight skips their text the same way
        ignore: self.ignoreTags + ", sup",
      }
      if (window.__readAloudHrgUi && window.__readAloudHrgUi.docMapChanged) window.__readAloudHrgUi.docMapChanged()
    }
    catch (err) {
      console.error(err)
    }
  }

  function findTextBlocks(threshold) {
    var skipTags = "h1, h2, h3, h4, h5, h6, p, a[href], " + self.ignoreTags;
    var isTextNode = function(node) {
      return node.nodeType == 3 && node.nodeValue.trim().length >= 3;
    };
    var isParagraph = function(node) {
      return node.nodeType == 1 && $(node).is("p:visible") && getInnerText(node).length >= threshold;
    };
    var hasTextNodes = function(elem) {
      return someChildNodes(elem, isTextNode) && getInnerText(elem).length >= threshold;
    };
    var hasParagraphs = function(elem) {
      return someChildNodes(elem, isParagraph);
    };
    var containsTextBlocks = function(elem) {
      var childElems = $(elem).children(":not(" + skipTags + ")").get();
      return childElems.some(hasTextNodes) || childElems.some(hasParagraphs) || childElems.some(containsTextBlocks);
    };
    var addBlock = function(elem, multi) {
      if (multi) $(elem).data("read-aloud-multi-block", true);
      textBlocks.push(elem);
    };
    var walk = function() {
      if ($(this).is("frame, iframe")) try {walk.call(this.contentDocument.body)} catch(err) {}
      else if ($(this).is("dl")) addBlock(this);
      else if ($(this).is("ol, ul")) {
        var items = $(this).children().get();
        if (items.some(hasTextNodes)) addBlock(this);
        else if (items.some(hasParagraphs)) addBlock(this, true);
        else if (items.some(containsTextBlocks)) addBlock(this, true);
      }
      else if ($(this).is("tbody")) {
        var rows = $(this).children();
        if (rows.length > 3 || rows.eq(0).children().length > 3) {
          if (rows.get().some(containsTextBlocks)) addBlock(this, true);
        }
        else rows.each(walk);
      }
      else {
        if (hasTextNodes(this)) addBlock(this);
        else if (hasParagraphs(this)) addBlock(this, true);
        else $(this).add(this.shadowRoot).children(":not(" + skipTags + ")").each(walk);
      }
    };
    var textBlocks = [];
    walk.call(document.body);
    return textBlocks.filter(function(elem) {
      return $(elem).is(":visible") && $(elem).offset().left >= 0;
    })
  }

  function getGaussian(texts, start, end) {
    if (start == undefined) start = 0;
    if (end == undefined) end = texts.length;
    var sum = 0;
    for (var i=start; i<end; i++) sum += texts[i].length;
    var mean = sum / (end-start);
    var variance = 0;
    for (var i=start; i<end; i++) variance += (texts[i].length-mean)*(texts[i].length-mean);
    return {mean: mean, stdev: Math.sqrt(variance)};
  }

  //each paragraph with the element it came from ({text, elem}); paragraphs split out of one
  //element's text share that element. Split at every line break, like a selection
  //(playText() in js/player.js) — the same separator, keep them in sync
  var lineSplitter = /\s*\r?\n\s*/;

  function getParas(elem) {
    var toHide = $(elem).find(":visible").filter(dontRead).hide();
    $(elem).find("ol, ul").addBack("ol, ul").each(addNumbering);
    var lines = function(text, el) {
      return text.split(lineSplitter).map(function(line) {return {text: line, elem: el}});
    }
    var paras = $(elem).data("read-aloud-multi-block")
      ? $(elem).children(":visible").get().flatMap(function(child) {return lines(getText(child), child)})
      : lines(getText(elem), elem);
    $(elem).find(".read-aloud-numbering").remove();
    toHide.show();
    return paras;
  }

  function addNumbering() {
    var children = $(this).children();
    var text = children.length ? getInnerText(children.get(0)) : null;
    if (text && !text.match(/^[(]?(\d|[a-zA-Z][).])/))
      children.each(function(index) {
        $("<span>").addClass("read-aloud-numbering").text((index +1) + ". ").prependTo(this);
      })
  }

  function dontRead() {
    var float = $(this).css("float");
    var position = $(this).css("position");
    return $(this).is(self.ignoreTags) || $(this).is("sup") || float == "right" || position == "fixed";
  }

  function getText(elem) {
    return addMissingPunctuation(elem.innerText).trim();
  }

  function addMissingPunctuation(text) {
    return text.replace(/(\w)(\s*?\r?\n)/g, "$1.$2");
  }

  function findHeadingsFor(block, prevBlock, article) {
    var result = [];
    var firstInnerElem = $(block).find("h1, h2, h3, h4, h5, h6, p").filter(":visible").get(0);
    var currentLevel = getHeadingLevel(firstInnerElem);
    var node = previousNode(block, true);
    while (node && node != prevBlock) {
      var ignore = $(node).is(self.ignoreTags);
      if (!ignore && node.nodeType == 1 && $(node).is(":visible")) {
        var level = getHeadingLevel(node);
        //blocks were filtered to the article: a heading from outside it (a sidebar's) doesn't belong
        if (level < currentLevel && (!article || article.has(node))) {
          result.push(node);
          currentLevel = level;
        }
      }
      node = previousNode(node, ignore);
    }
    return result.reverse();
  }

  function getHeadingLevel(elem) {
    var matches = elem && /^H(\d)$/i.exec(elem.tagName);
    return matches ? Number(matches[1]) : 100;
  }

  function previousNode(node, skipChildren) {
    if ($(node).is('body')) return null;
    if (node.nodeType == 1 && !skipChildren && node.lastChild) return node.lastChild;
    if (node.previousSibling) return node.previousSibling;
    if (node.parentNode) return previousNode(node.parentNode, true);
    return null;
  }

  function someChildNodes(elem, test) {
    var child = elem.firstChild;
    while (child) {
      if (test(child)) return true;
      child = child.nextSibling;
    }
    return false;
  }
}
