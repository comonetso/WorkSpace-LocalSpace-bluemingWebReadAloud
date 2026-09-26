
var readAloudDoc = (function() {
  if ($(".kix-canvas-tile-content > svg").length) return new SvgReadAloudDoc()
  if ($(".kix-paragraphrenderer").length) return new LegacyReadAloudDoc()
  return new ModelChunkReadAloudDoc()
})();


async function altGetTexts() {
  const text = Array.from(document.body.children)
    .filter(el => el.tagName == "SCRIPT")
    .map(el => el.innerText)
    .filter(text => text.startsWith("DOCS_modelChunk = ") && text.endsWith("; DOCS_modelChunkLoadStart = new Date().getTime(); _getTimingInstance().incrementTime('mp', DOCS_modelChunkLoadStart - DOCS_modelChunkParseStart); DOCS_warmStartDocumentLoader.loadModelChunk(DOCS_modelChunk); DOCS_modelChunk = undefined;"))
    .map(text => text.slice(18, -237))
    .map(JSON.parse)
    .map(data => data[0].s)
    .join("")
    .trim()
  if (!text) throw new Error("No text found")
  return text.split(/\s*\r?\n\s*/)
}



//the document text from the page's own model data (DOCS_modelChunk): used when the canvas isn't
//annotated (js/page/google-doc.js) and the old HTML renderer isn't there either
function ModelChunkReadAloudDoc() {
  this.getCurrentIndex = function() {
    return altGetTexts()
      .then(() => 0)
      .catch(() => Promise.reject(new Error(JSON.stringify({code: "error_page_unreadable"}))))
  }

  this.getTexts = function(index) {
    return index == 0 ? altGetTexts() : null
  }
}




function LegacyReadAloudDoc() {
  var viewport = $(".kix-appview-editor").get(0);
  var pages = $(".kix-page");

  this.getCurrentIndex = function() {
    if (getSelectedText()) return 9999;

    for (var i=0; i<pages.length; i++) if (pages.eq(i).position().top > viewport.scrollTop+$(viewport).height()/2) break;
    return i-1;
  }

  this.getTexts = function(index, quietly) {
    if (index == 9999) return [getSelectedText()];

    var page = pages.get(index);
    if (page) {
      var oldScrollTop = viewport.scrollTop;
      viewport.scrollTop = $(page).position().top;
      return tryGetTexts(getTexts.bind(page), 2000)
        .then(function(result) {
          if (quietly) viewport.scrollTop = oldScrollTop;
          return result;
        })
    }
    else return null;
  }

  function getTexts() {
    return $(".kix-paragraphrenderer", this).get()
      .map(getInnerText)
      .map(removeDumbChars)
      .filter(isNotEmpty)
  }

  function getSelectedText() {
    hack();
    var doc = googleDocsUtil.getGoogleDocument();
    return removeDumbChars(doc.selectedText);
  }

  function removeDumbChars(text) {
    return text && text.replace(/[\n\u200c]+/g, '');
  }

  function hack() {
    var selections = $(".kix-selection-overlay").get();
    var windowHeight = $(window).height();

    //find one selection-overlay inside viewport
    var index = binarySearch(selections, function(el) {
      var viewportOffset = el.getBoundingClientRect();
      if (viewportOffset.top < 120) return 1;
      if (viewportOffset.top >= windowHeight) return -1;
      return 0;
    })

    if (index != -1) {
      var validSelections = [selections[index]];

      //identify the contiguous selection region
      var line = selections[index].parentNode;
      while (true) {
        line = findPreviousLine(line);
        if (line && $(line).hasClass("kix-lineview") && $(line.firstElementChild).hasClass("kix-selection-overlay")) validSelections.push(line.firstElementChild);
        else break;
      }

      line = selections[index].parentNode;
      while (true) {
        line = findNextLine(line);
        if (line && $(line).hasClass("kix-lineview") && $(line.firstElementChild).hasClass("kix-selection-overlay")) validSelections.push(line.firstElementChild);
        else break;
      }

      //remove all other selection-overlays
      if (selections.length != validSelections.length) $(selections).not(validSelections).remove();
    }
    else {
      $(selections).remove();
    }
  }

  function binarySearch(arr, testFn) {
    var m = 0;
    var n = arr.length - 1;
    while (m <= n) {
      var k = (n + m) >> 1;
      var cmp = testFn(arr[k]);
      if (cmp > 0) m = k + 1;
      else if (cmp < 0) n = k - 1;
      else return k;
    }
    return -1;
  }

  function findPreviousLine(line) {
    return line.previousElementSibling ||
      line.parentNode.previousElementSibling && line.parentNode.previousElementSibling.lastElementChild ||
      $(line).closest(".kix-page").prev().find(".kix-page-content-wrapper .kix-lineview").get(-1)
  }

  function findNextLine(line) {
    return line.nextElementSibling ||
      line.parentNode.nextElementSibling && line.parentNode.nextElementSibling.firstElementChild ||
      $(line).closest(".kix-page").next().find(".kix-page-content-wrapper .kix-lineview").get(0)
  }
}




function SvgReadAloudDoc() {
  var currentPageMarker, currentPageNumber

  this.getCurrentIndex = function() {
    currentPageMarker = markPage(getCurrentlyVisiblePage(getPages()))
    return currentPageNumber = 1000
  }

  this.getTexts = async function(nextPageNumber, quietly) {
    var pages = getPages(), head = 0, tail = pages.length-1

    // find index of current page and next page
    const currentIndex = pages.findIndex(currentPageMarker.matches)
    if (currentIndex == -1) return null
    var nextIndex = currentIndex + (nextPageNumber - currentPageNumber)

    // function to remove overlap between pages (in Pageless mode)
    const overlapRemover = nextPageNumber == currentPageNumber +1
      ? makeOverlapRemover(pages[currentIndex])
      : () => true;

    // if the next page is not loaded and is an earlier page
    if (nextIndex < head) {
      pages[head].scrollIntoView(); await waitMillis(500)
      nextIndex -= head
      const headMarker = markPage(pages[head])
      pages = getPages()
      nextIndex += pages.findIndex(headMarker.matches)
      if (outOfBounds(nextIndex, pages)) return null
    }

    // if the next page is not loaded and is a later page
    if (nextIndex > tail) {
      pages[tail].scrollIntoView(false); await waitMillis(500)
      nextIndex -= tail
      const tailMarker = markPage(pages[tail])
      pages = getPages()
      nextIndex += pages.findIndex(tailMarker.matches)
      if (outOfBounds(nextIndex, pages)) return null
    }

    // set next page as current
    const currentPage = pages[nextIndex]
    currentPageMarker = markPage(currentPage)
    currentPageNumber = nextPageNumber

    // scroll into view and return text
    if (!quietly) currentPage.scrollIntoView()
    return $("svg > g[role=paragraph]", currentPage).get()
      .flatMap(para => {
        return $(para).children("rect").get()
          .map(el => el.getAttribute("aria-label"))
          .filter(overlapRemover)
          .filter(makeDeduper())
          .join(" ") || []
      })
  }

  this.getSelectedText = function() {
    const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
    const page = getCurrentlyVisiblePage(getPages())
    const selectionRects = $(".kix-canvas-tile-selection > svg > rect", page).get()
      .map(el => el.getBoundingClientRect())
    return $("svg > g[role=paragraph] > rect", page).get()
      .map(el => ({el: el, rect: el.getBoundingClientRect()}))
      .filter(item => selectionRects.some(rect => overlaps(item.rect, rect)))
      .map(item => item.el.getAttribute("aria-label"))
      .filter(makeDeduper())
      .join(" ")
  }

  function getDocContainer() {
    if($(".kix-page-paginated").length) {
      console.log("Paginated google doc detected.");
      return $(".kix-page-paginated").get();
    } else if($(".kix-rotatingtilemanager-content").length) {
      console.log("Pageless google doc detected.");
      return $(".kix-rotatingtilemanager-content").children().get();
    } else {
      console.log("Could not detect paginated or pageless google doc.");
    }
  }

  function getPages() {
      return getDocContainer()
      .map(page => ({page: page, top: page.getBoundingClientRect().top}))
      .sort((a,b) => a.top-b.top)
      .map(item => item.page)
  }

  function getCurrentlyVisiblePage(pages) {
    const halfHeight = $(window).height() / 2
    for (var i=pages.length-1; i>=0; i--) if (pages[i].getBoundingClientRect().top < halfHeight) return pages[i]
    throw new Error("Can't get the currently visible page")
  }

  function markPage(page) {
    const top = page.style.top
    return {
      matches: x => x.style.top == top
    }
  }

  function outOfBounds(index, arr) {
    return index < 0 || index >= arr.length
  }

  function makeDeduper() {
    let prev
    return function(text) {
      if (text == prev) return false
      prev = text
      return true
    }
  }

  function makeOverlapRemover(prevPage) {
    const prevPageTexts = Array.from(prevPage.querySelectorAll("svg > g[role=paragraph] > rect"))
      .map(rect => rect.getAttribute("aria-label"))
    var indexOfLastMatch = null
    return function(text) {
      if (indexOfLastMatch == null) {
        //find index of the start of the overlapping section
        indexOfLastMatch = prevPageTexts.lastIndexOf(text)
        if (indexOfLastMatch != -1) console.debug("Overlap detected", prevPageTexts.length-indexOfLastMatch)
      }
      else if (indexOfLastMatch > 0) {
        //if subsequent lines match, keep incrementing index
        if (prevPageTexts[indexOfLastMatch +1] == text) indexOfLastMatch += 1
        else indexOfLastMatch = -1
      }
      //return false to filter out matches
      return indexOfLastMatch > 0 ? false : true
    }
  }
}
