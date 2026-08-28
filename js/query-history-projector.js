(function() {
  "use strict";

  const SNAPSHOT_TEXT_FIELDS = ["displayWord", "phonetic", "pos", "meaning"];
  const VOCAB_FIELDS = [
    "word",
    "count",
    "articleCount",
    "searchCount",
    "firstSeen",
    "lastSeen",
    "displayWord",
    "phonetic",
    "pos",
    "meaning",
    "dictionaryFound",
    "source"
  ];

  function compareStrings(left, right) {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  }

  function defineDataProperty(target, key, value) {
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value
    });
  }

  function hasOwn(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
  }

  function ensureAggregate(target, word) {
    if (hasOwn(target, word)) return target[word];
    const aggregate = {
      word,
      count: 0,
      articleCount: 0,
      searchCount: 0
    };
    defineDataProperty(target, word, aggregate);
    return aggregate;
  }

  function mergeTimes(aggregate, firstSeen, lastSeen) {
    if (firstSeen && (!aggregate.firstSeen || firstSeen < aggregate.firstSeen)) {
      aggregate.firstSeen = firstSeen;
    }
    if (lastSeen && (!aggregate.lastSeen || lastSeen > aggregate.lastSeen)) {
      aggregate.lastSeen = lastSeen;
    }
  }

  function mergeSnapshot(aggregate, source) {
    for (const field of SNAPSHOT_TEXT_FIELDS) {
      if (source[field]) aggregate[field] = source[field];
    }
    if (typeof source.dictionaryFound === "boolean") {
      aggregate.dictionaryFound = source.dictionaryFound;
    }
    if (source.source) aggregate.source = source.source;
  }

  function mergeBaselineRecord(target, record) {
    const aggregate = ensureAggregate(target, record.word);
    aggregate.count += record.count;
    aggregate.articleCount += hasOwn(record, "articleCount") ? record.articleCount : 0;
    aggregate.searchCount += hasOwn(record, "searchCount") ? record.searchCount : 0;
    mergeTimes(aggregate, record.firstSeen, record.lastSeen);
    mergeSnapshot(aggregate, record);
  }

  function mergeQueryEvent(target, event) {
    if (event.word === "") return;
    const aggregate = ensureAggregate(target, event.word);
    aggregate.count += 1;
    aggregate.articleCount += event.source === "article" ? 1 : 0;
    aggregate.searchCount += event.source === "search" ? 1 : 0;
    mergeTimes(aggregate, event.timestamp, event.timestamp);
    mergeSnapshot(aggregate, event);
  }

  function copyFormalVocabFields(aggregate) {
    const snapshot = {};
    for (const field of VOCAB_FIELDS) {
      if (hasOwn(aggregate, field)) snapshot[field] = aggregate[field];
    }
    return snapshot;
  }

  function project(queryEvents, historyBaselines) {
    if (!Array.isArray(queryEvents) || !Array.isArray(historyBaselines)) {
      throw new TypeError("Query History Projector requires array inputs.");
    }

    const aggregateByWord = Object.create(null);
    const sortedBaselines = historyBaselines.slice().sort((left, right) => (
      compareStrings(left.createdAt, right.createdAt) || compareStrings(left.id, right.id)
    ));

    for (const baseline of sortedBaselines) {
      const locators = Object.keys(baseline.records).sort(compareStrings);
      for (const locator of locators) {
        mergeBaselineRecord(aggregateByWord, baseline.records[locator]);
      }
    }

    const sortedEvents = queryEvents.slice().sort((left, right) => (
      compareStrings(left.timestamp, right.timestamp) || compareStrings(left.id, right.id)
    ));
    for (const event of sortedEvents) mergeQueryEvent(aggregateByWord, event);

    const vocab = Object.create(null);
    for (const word of Object.keys(aggregateByWord).sort(compareStrings)) {
      defineDataProperty(vocab, word, copyFormalVocabFields(aggregateByWord[word]));
    }
    return vocab;
  }

  window.LingoFlowQueryHistoryProjector = Object.freeze({ project });
})();
