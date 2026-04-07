var urlManager = {
    urls: new Map(),
    
    create: function(blob, id) {
        var url = URL.createObjectURL(blob);
        if (id) {
            if (!this.urls.has(id)) {
                this.urls.set(id, []);
            }
            this.urls.get(id).push(url);
        }
        return url;
    },
    
    revoke: function(id) {
        if (this.urls.has(id)) {
            this.urls.get(id).forEach(function(url) { URL.revokeObjectURL(url); });
            this.urls.delete(id);
        }
    },
    
    revokeAll: function() {
        this.urls.forEach(function(urls) {
            urls.forEach(function(url) { URL.revokeObjectURL(url); });
        });
        this.urls.clear();
    }
};