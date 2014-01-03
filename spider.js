var jsdom = require('jsdom'),
    db = require("mongojs").connect("spell", ["pages", "projects"]),
    fs = require("fs"),
    jquery = fs.readFileSync("./htdocs/static/js/jquery-2.0.3.min.js", "utf-8"),
    request = require('request'),
    breakException = {},
    async = require("async"),
    myName = require("mongojs").ObjectId();



var isHtml = function(url, callback) {
    request.head(url, function (error, response) {
        if (!error && response.statusCode == 200
            && response.headers["content-type"].indexOf('text/html') != -1) {
            callback(true);
        } else {
            callback(false);
        }
    });
};

var fetchUrl = function(url, callback) {
    console.error(':::::Fetching ' + url);
    jsdom.env({
        url: url,
        src: [jquery],
        done: function (err, window) {
            if (err) {
                console.log('Got error while fetching url', err);
                setTimeout(fetchUrl(url, callback), 1000);
                return;
            }
            callback(window.jQuery, window);
        }
    });
};

var getAttr = function($, attr) {
    var result = [];
    $("["+ attr +"]").each(function() {
        var text = $(this).attr(attr);
        if (text) {
            result.push(text);
        }
    });
    return result;
};

var getWords = function($, window) {
    var text = "";
    $('script').remove();
    $('style').remove();
    $('noscript').remove();
    $('br').replaceWith(". ");
    //removing html comments
    $('*').contents().each(function() {
        if(this.nodeType == 8) {
            $(this).remove()
        }
    });
    text = $('body').text().replace(/\s{2,}/g, ' ');
    var otherTexts = getAttr($, 'title')
        .concat(getAttr($, 'alt'));
    $("[value][type!=hidden]").each(function() {
        var text = $(this).val();
        if (text) {
            otherTexts.push(text);
        }
    });
    otherTexts.push(window.document.title);
    otherTexts.push($('meta[name=keywords]').attr("content"));
    otherTexts.push($('meta[name=description]').attr("content"));
    otherTexts.push(text);
    otherTexts.join(" ");
    text = text.replace(/(ё)/g, "е")
        .replace(/(Ё)/g, "Е")
        .replace(/\b(https?:\/\/)?([\da-z.-]+).([a-z.]{2,6})([\/\w .-])\/?\b/g, " ")
        .replace(/\b(([^<>()[\]\\.,;:\s@\"]+(\.[^<>()[\]\\.,;:\s@\"]+)*)|(\".+\"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))\b/g, " ")
        .replace(/[^a-zA-Zа-яА-Я]/g, " ")
        .replace(/[0-9]/g, " ");
    var wordsDirty = text.split(/\s+/);
    var words = [];
    for (var i in wordsDirty) {
        var word = wordsDirty[i];
        if (word.length > 2
            && word[0] !== word[0].toUpperCase()) {
            words.push(word);
        }
    }
    return words;
};

var findAndInsertUrls = function($, page, callback) {
    var host = page.url.replace(/^\w+:\/\//, "").replace(/\/.*$/, "");
    var processLink = function($a, callback) {
        if ($a.href.indexOf(host) == -1) {
            callback(null, false);
            return;
        }
        var url = $a.href.replace(/#.*$/, "").replace(/\/\/www\./, "//");
        isHtml(url, function(isHtml) {
            if (!isHtml) {
                callback(null, false);
                return;
            }
            db.pages.insert({
                project_id: page.project_id,
                url: url
            }, function() {
                callback(null, true);
            });
        });
    };
    async.map($.makeArray($("a")), processLink, function() {
        callback();
    });
};

var analyzePage = function(page, callback) {
    fetchUrl(page.url, function($, window) {
        console.log(":::: Got text", page.url);
        //var words = getWords($, window);
        db.pages.update({_id: page._id}, {$set: {words: [], downloaded_at: new Date()}});
        /*findAndInsertUrls($, page, function() {
            callback(page);
        });*/
        callback(page);
    });
};

var Pool = function(max) {
    this.max = max;
    this.inProgress = [];
};

Pool.prototype.finished = function(page) {
    console.log('finished', page.url);
    db.pages.update(
        {processing_by: myName, _id: page._id},
        {$unset: {processing_by: "", processing_started_at: ""}}
    );
    this.inProgress = this.inProgress.filter(function(element){
        return !page._id.equals(element._id);
    });
    this.addPages();
};

Pool.prototype.launch = function(page) {
    var me = this;
    console.log('::: Adding page to pool:', page.url);
    this.inProgress.push(page);
    analyzePage(page, function(page) {
        me.finished(page);
    });
};

Pool.prototype.isInProgress = function(page) {
    var i = this.inProgress.length;
    while (i--) {
        if (page._id.equals(this.inProgress[i]._id)) {
            return true;
        }
    }
    return false;
};

Pool.prototype.addPage = function(project) {
    var me = this;
    db.pages.findAndModify({
        query: {
            project_id: project._id,
            downloaded_at: {$exists: false},
            processing_by: {$exists: false}
        },
        update: {$set: {processing_by: myName, processing_started_at: new Date()}}
    }, function(err, page) {
        if (!page || me.isInProgress(page)) {
            return;
        }
        me.launch(page);
    });
}

Pool.prototype.addPages = function() {
    var me = this;
    if (me.inProgress.length == me.max) {
        console.log('pool size exceeded');
    }
    db.projects.find().sort({created: -1}, function(err, projects) {
        if (projects.length == 0) {
            console.log("No projects found");
            if (me.inProgress.length == 0) {
                setTimeout(function() {
                    me.addPages();
                }, 1);
            }
            return;
        }
        try {
            projects.forEach(function(project) {
                if (me.inProgress.length == me.max) {
                    console.log('pool size exceeded');
                    throw breakException;
                }
                if (!project.started_at) {
                    console.log('adding front page for project');
                    db.pages.insert({
                        project_id: project._id,
                        url: project.url
                    }, function(err) {
                        if (err) throw err;
                        db.projects.update({_id: project._id}, {
                            $set: {started_at: new Date()}
                        }, function(err) {
                            if (err) throw err;
                            me.addPage(project);
                            me.addPages();
                            return;
                        });
                    });
                } else {
                    me.addPage(project);
                    me.addPages();
                    return;
                }
            });
        } catch (e) {
            if (e == breakException) {
                return;
            }
            throw e;
        }
    });
};


var p = new Pool(5);
console.log('Starting spider process', myName);
p.addPages();
