/*!
 * BackFire is the officially supported Backbone binding for Firebase. The
 * bindings let you use special model and collection types that allow for
 * synchronizing data with Firebase.
 *
 * BackFire 0.4.0
 * https://github.com/firebase/backfire/
 * License: MIT
 */

(function(_, Backbone) {
  "use strict";

  Backbone.Firebase = function() {};

  // Syncing for once only
  Backbone.Firebase.sync = function(method, model, options) {
    var modelJSON = model.toJSON();

    if (method === 'read') {

      model.firebase.once('value', function(snap) {
        var resp = snap.val();
        options.success(resp);
      }, this);

    } else if (method === 'create') {

      model.firebase.set(modelJSON, function(err) {

        if(err) {
          options.error(model, err, options);
        } else {
          options.success(model, null, options);
        }

      });

    } else if (method === 'update') {

      model.firebase.update(modelJSON, function(err) {

        if(err) {
          options.error(modelJSON, err, options);
        } else {
          options.success(modelJSON, null, options);
        }

      });

    }

  };

  // Model responsible for autoSynced objects
  // This model is never directly used. The Backbone.Firebase.Model will
  // inherit from this if it is an autoSynced model
  var SyncModel = (function() {

    function SyncModel() {
      // Set up sync events

      // apply remote changes locally
      this.firebase.on('value', function(snap) {
        this._setLocal(snap);
        this.trigger('sync', this, null, null);
      }, this);

      // apply local changes remotely
      this._listenLocalChange(function(model) {
        this.firebase.update(model);
      });

    }

    SyncModel.protoype = {
      save: function() {
        console.warn('Save called on a Firebase model with autoSync enabled, ignoring.');
      },
      fetch: function() {
        console.warn('Save called on a Firebase model with autoSync enabled, ignoring.');
      },
      sync: function() {
        console.warn('Sync called on a Fireabse model with autoSync enabled, ignoring.');
      }
    };

    return SyncModel;
  }());

  // Model responsible for one-time requests
  // This model is never directly used. The Backbone.Firebase.Model will
  // inherit from this if it is not an autoSynced model
  var OnceModel = (function() {

    function OnceModel() {

      // when an unset occurs set the key to null
      // so Firebase knows to delete it on the server
      this._listenLocalChange(function(model) {
        this.set(model, { silent: true });
      });

    }

    OnceModel.protoype = {

      sync: function(method, model, options) {
        Backbone.Firebase.sync(method, model, options);
      }

    };

    return OnceModel;
  }());

  Backbone.Firebase.Model = Backbone.Model.extend({

    // Determine whether the realtime or once methods apply
    constructor: function(model, options) {
      var defaults = _.result(this, 'defaults');

      // Apply defaults only after first sync.
      this.once('sync', function() {
        this.set(_.defaults(this.toJSON(), defaults));
      });

      Backbone.Model.apply(this, arguments);
      _.extend(this, { autoSync: true }, options);

      switch (typeof this.url) {
      case 'string':
        this.firebase = new Firebase(this.url);
        break;
      case 'function':
        this.firebase = new Firebase(this.url());
        break;
      default:
        throw new Error('url parameter required');
      }

      if(!this.autoSync) {
        OnceModel.apply(this, arguments);
        _.extend(this, OnceModel.protoype);
      } else {
        _.extend(this, SyncModel.protoype);
        SyncModel.apply(this, arguments);
      }

    },

    destroy: function(options) {
      options = _.extend({}, options);
      this.firebase.set(null, function(err) {
        if(err) {

          if(options.error) {
            options.error(this, err, options);
          }

        } else {

          if(options.success) {
            options.success(this, null, options);
          }

        }
      });
      this.trigger('destroy', this, null, options);
    },

    // siliently set the id of the model to the snapshot name
    _setId: function(snap) {
      // if the item new set the name to the id
      if(this.isNew()) {
        this.set('id', snap.name(), { silent: true });
      }
    },

    // proccess changes from a snapshot and apply locally
    _setLocal: function(snap) {
      var newModel = this._processChanges(snap);
      this.set(newModel);
    },

    // Unset attributes that have been deleted from the server
    // by comparing the keys that have been removed.
    _processChanges: function(snap) {

      // TODO: Tell if the object has been destroyed
      var newModel = snap.val();

      if (typeof newModel === 'object' && newModel !== null) {
        var diff = _.difference(_.keys(this.attributes), _.keys(newModel));
        _.each(diff, _.bind(function(key) {
          this.unset(key);
        }, this));
      }

      // check to see if it needs an id
      this._setId(snap);

      return newModel;
    },

    // Find the deleted keys and set their values to null
    // so Firebase properly deletes them.
    _updateModel: function(model) {
      var modelObj = model.changedAttributes();
      _.each(model.changed, function(value, key) {
        if (typeof value === "undefined" || value === null) {
          if (key == "id") {
            delete modelObj[key];
          } else {
            modelObj[key] = null;
          }
        }
      });

      return modelObj;
    },

    // determine if we will update the model for every change
    _listenLocalChange: function(cb) {
      var method = cb ? 'on' : 'off';
      this[method]('change', function(model) {
        var newModel = this._updateModel(model);
        if(_.isFunction(cb)){
          cb.call(this, newModel);
        }
      }, this);
    }

  });

  // Custom Firebase Collection.
  Backbone.Firebase.Collection = Backbone.Collection.extend({
    sync: function() {
      this._log("Sync called on a Firebase collection, ignoring.");
    },

    fetch: function() {
      this._log("Fetch called on a Firebase collection, ignoring.");
    },

    constructor: function(models, options) {
      // Apply parent constructor (this will also call initialize).
      Backbone.Collection.apply(this, arguments);

      if (options && options.firebase) {
        this.firebase = options.firebase;
      }
      switch (typeof this.firebase) {
      case "object":
        break;
      case "string":
        this.firebase = new Firebase(this.firebase);
        break;
      case "function":
        this.firebase = this.firebase();
        break;
      default:
        throw new Error("Invalid firebase reference created");
      }

      // Add handlers for remote events.
      this.firebase.on("child_added", _.bind(this._childAdded, this));
      this.firebase.on("child_moved", _.bind(this._childMoved, this));
      this.firebase.on("child_changed", _.bind(this._childChanged, this));
      this.firebase.on("child_removed", _.bind(this._childRemoved, this));

      // Once handler to emit "sync" event.
      this.firebase.once("value", _.bind(function() {
        this.trigger("sync", this, null, null);
      }, this));

      // Handle changes in any local models.
      this.listenTo(this, "change", this._updateModel, this);
      // Listen for destroy event to remove models.
      this.listenTo(this, "destroy", this._removeModel, this);

      // Don't suppress local events by default.
      this._suppressEvent = false;
    },

    comparator: function(model) {
      return model.id;
    },

    add: function(models, options) {
      var parsed = this._parseModels(models);
      options = options ? _.clone(options) : {};
      options.success =
        _.isFunction(options.success) ? options.success : function() {};

      for (var i = 0; i < parsed.length; i++) {
        var model = parsed[i];
        var childRef = this.firebase.ref().child(model.id);
        if (options.silent === true) {
          this._suppressEvent = true;
        }
        childRef.set(model, _.bind(options.success, model));
      }

      return parsed;
    },

    remove: function(models, options) {
      var parsed = this._parseModels(models);
      options = options ? _.clone(options) : {};
      options.success =
        _.isFunction(options.success) ? options.success : function() {};

      for (var i = 0; i < parsed.length; i++) {
        var model = parsed[i];
        var childRef = this.firebase.ref().child(model.id);
        if (options.silent === true) {
          this._suppressEvent = true;
        }
        childRef.set(null, _.bind(options.success, model));
      }

      return parsed;
    },

    create: function(model, options) {
      options = options ? _.clone(options) : {};
      if (options.wait) {
        this._log("Wait option provided to create, ignoring.");
      }
      model = Backbone.Collection.prototype._prepareModel.apply(
        this, [model, options]
      );
      if (!model) {
        return false;
      }
      var set = this.add([model], options);
      return set[0];
    },

    reset: function(models, options) {
      options = options ? _.clone(options) : {};
      // Remove all models remotely.
      this.remove(this.models, {silent: true});
      // Add new models.
      var ret = this.add(models, {silent: true});
      // Trigger "reset" event.
      if (!options.silent) {
        this.trigger("reset", this, options);
      }
      return ret;
    },

    _log: function(msg) {
      if (console && console.log) {
        console.log(msg);
      }
    },

    // TODO: Options will be ignored for add & remove, document this!
    _parseModels: function(models) {
      var ret = [];
      models = _.isArray(models) ? models.slice() : [models];
      for (var i = 0; i < models.length; i++) {
        var model = models[i];
        if (model.toJSON && typeof model.toJSON == "function") {
          model = model.toJSON();
        }
        if (!model.id) {
          model.id = this.firebase.ref().push().name();
        }
        ret.push(model);
      }
      return ret;
    },

    _childAdded: function(snap) {
      var model = snap.val();
      if (!model.id) {
        if (!_.isObject(model)) {
          model = {};
        }
        model.id = snap.name();
      }
      if (this._suppressEvent === true) {
        this._suppressEvent = false;
        Backbone.Collection.prototype.add.apply(this, [model], {silent: true});
      } else {
        Backbone.Collection.prototype.add.apply(this, [model]);
      }
      this.get(model.id)._remoteAttributes = model;
    },

    _childMoved: function(snap) {
      // TODO: Investigate: can this occur without the ID changing?
      this._log("_childMoved called with " + snap.val());
    },

    _childChanged: function(snap) {
      var model = snap.val();
      if (!model.id) {
        model.id = snap.name();
      }

      var item = _.find(this.models, function(child) {
        return child.id == model.id;
      });

      if (!item) {
        // TODO: Investigate: what is the right way to handle this case?
        throw new Error("Could not find model with ID " + model.id);
      }

      this._preventSync(item, true);
      item._remoteAttributes = model;

      var diff = _.difference(_.keys(item.attributes), _.keys(model));
      _.each(diff, function(key) {
        item.unset(key);
      });

      item.set(model);
      this._preventSync(item, false);
    },

    _childRemoved: function(snap) {
      var model = snap.val();
      if (!model.id) {
        model.id = snap.name();
      }
      if (this._suppressEvent === true) {
        this._suppressEvent = false;
        Backbone.Collection.prototype.remove.apply(
          this, [model], {silent: true}
        );
      } else {
        Backbone.Collection.prototype.remove.apply(this, [model]);
      }
    },

    // Add handlers for all models in this collection, and any future ones
    // that may be added.
    _updateModel: function(model) {
      if (model._remoteChanging) {
        return;
      }

      var remoteAttributes = model._remoteAttributes || {};
      var localAttributes = model.toJSON();
      var updateAttributes = {};

      var union = _.union(_.keys(remoteAttributes), _.keys(localAttributes));
      _.each(union, function(key) {
        if (!_.has(localAttributes, key)) {
          updateAttributes[key] = null;
        } else if (localAttributes[key] != remoteAttributes[key]) {
          updateAttributes[key] = localAttributes[key];
        }
      });

      if (_.size(updateAttributes)) {
        // Special case if ".priority" was updated - a merge is not
        // allowed so we'll have to do a full setWithPriority.
        if (_.has(updateAttributes, ".priority")) {
          var ref = this.firebase.ref().child(model.id);
          var priority = localAttributes[".priority"];
          delete localAttributes[".priority"];
          ref.setWithPriority(localAttributes, priority);
        } else {
          this.firebase.ref().child(model.id).update(updateAttributes);
        }
      }
    },

    // Triggered when model.destroy() is called on one of the children.
    _removeModel: function(model, collection, options) {
      options = options ? _.clone(options) : {};
      options.success =
        _.isFunction(options.success) ? options.success : function() {};
      var childRef = this.firebase.ref().child(model.id);
      childRef.set(null, _.bind(options.success, model));
    },

    _preventSync: function(model, state) {
      model._remoteChanging = state;
    }
  });

})(window._, window.Backbone);
