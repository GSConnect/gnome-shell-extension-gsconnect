# This has been modified from the work shimming Gee by Hugo Sena Ribeiro. The
# original code is available here: https://github.com/hugosenari/folks

import gi
gi.require_version('Folks', '0.6')
import itertools
import json
import os.path
import re
import ctypes as pyc
from ctypes import pythonapi
from gi.repository import Folks, GLib, GObject
pyc.cdll.LoadLibrary('libgobject-2.0.so')
lego = pyc.CDLL('libgobject-2.0.so')
lego.g_type_name.restype = pyc.c_char_p
lego.g_type_name.argtypes = (pyc.c_ulonglong,)
pythonapi.PyCapsule_GetName.restype = pyc.c_char_p
pythonapi.PyCapsule_GetName.argtypes = (pyc.py_object,)
pythonapi.PyCapsule_GetPointer.restype = pyc.c_void_p
pythonapi.PyCapsule_GetPointer.argtypes = (pyc.py_object, pyc.c_char_p)


###############################################################################
# GObject
###############################################################################

class _PyGObject_Functions(pyc.Structure):
    _fields_ = [
        ('pygobject_register_class',
            pyc.PYFUNCTYPE(pyc.c_void_p)),
        ('pygobject_register_wrapper',
            pyc.PYFUNCTYPE(pyc.c_void_p)),
        ('pygobject_lookup_class',
            pyc.PYFUNCTYPE(pyc.c_void_p)),
        ('pygobject_new',
            pyc.PYFUNCTYPE(pyc.py_object, pyc.c_void_p)),
        ]


def capsule_name(capsule):
    return pythonapi.PyCapsule_GetName(capsule)


def capsule_ptr(capsule):
    name = capsule_name(capsule)
    return pythonapi.PyCapsule_GetPointer(capsule, name)


class _PyGO_CAPI(object):
    '''
    Static class to that create PyObject (object) from GObject (pointer)
    '''
    _api = None

    @classmethod
    def _set_api(cls):
        addr = capsule_ptr(gi._gobject._PyGObject_API)
        cls._api = _PyGObject_Functions.from_address(addr)

    @classmethod
    def to_object(cls, addr):
        cls._api or cls._set_api()
        return cls._api.pygobject_new(addr)


###############################################################################
# GType
###############################################################################

INT, ADDRESS, NONE, NOT_IMPLEMENTED = range(4)

G_PY_INT = {
    (GObject.TYPE_BOOLEAN,   pyc.c_bool),
    (GObject.TYPE_UNICHAR,   pyc.c_ubyte),
    (GObject.TYPE_UCHAR,     pyc.c_ubyte),
    (GObject.TYPE_CHAR,      pyc.c_char),
    (GObject.TYPE_INT,       pyc.c_int),
    (GObject.TYPE_UINT,      pyc.c_uint),
    (GObject.TYPE_FLAGS,     pyc.c_uint),
}

G_PY_ADDRESS = {
    (GObject.TYPE_LONG,      pyc.c_long),
    (GObject.TYPE_DOUBLE,    pyc.c_double),
    (GObject.TYPE_ULONG,     pyc.c_ulong),
    (GObject.TYPE_INT64,     pyc.c_longlong),
    (GObject.TYPE_UINT64,    pyc.c_ulonglong),
    (GObject.TYPE_ENUM,      pyc.c_ulonglong),
    (GObject.TYPE_FLOAT,     pyc.c_float),
    (GObject.TYPE_STRING,    pyc.c_char_p),
    (GObject.TYPE_POINTER,   pyc.c_void_p),
    (GObject.TYPE_OBJECT,    pyc.c_void_p),
    (GObject.TYPE_PYOBJECT,  pyc.py_object),
}

G_PY_NONE = {
    (GObject.TYPE_NONE,      None),
    (GObject.TYPE_INVALID,   None),
}

G_PY_NOT_IMPLEMENTED = {
    (GObject.TYPE_PARAM,     None),
    (GObject.TYPE_STRV,      None),
    (GObject.TYPE_VARIANT,   None),
    (GObject.TYPE_BOXED,     None),
    (GObject.TYPE_INTERFACE, None),
}

TYPES_G_PY = G_PY_INT | G_PY_ADDRESS | G_PY_NONE | G_PY_NOT_IMPLEMENTED

TYPES_ID = {hash(gt): (gt, ct, INT) for gt, ct in G_PY_INT}
_u = TYPES_ID.update
_u({hash(gt): (gt, ct, ADDRESS) for gt, ct in G_PY_ADDRESS})
_u({hash(gt): (gt, ct, NONE) for gt, ct in G_PY_NONE})
_u({hash(gt): (gt, ct, NOT_IMPLEMENTED) for gt, ct in G_PY_NOT_IMPLEMENTED})


def gtype_name_of(gtype_id=0):
    '''
    Return a name of gtype if type is a class

    this method use glib/gobjec/gtype.c/g_type_name
    see code
    https://github.com/GNOME/glib/blob/master/gobject/gtype.c#L3787
    '''
    name = lego.g_type_name(hash(gtype_id))
    return name and name.decode('utf-8')


def gtype_and_ctype_of(gtype_id=0):
    '''
    return (GType, ctype) of gtype_id
    May return (None, None, NOT_IMPLEMENTED)
    '''
    _default = (None, None, NOT_IMPLEMENTED)
    g_and_c_type = TYPES_ID.get(hash(gtype_id), _default)
    if not g_and_c_type[0]:
        name = gtype_name_of(gtype_id)
        if name:
            gtype = GObject.GType.from_name(name)
            parent_id = hash(gtype.parent)
            parent = TYPES_ID.get(parent_id, _default)
            g_and_c_type = (gtype, pyc.c_void_p, parent[2])
    return g_and_c_type


def from_int(value, gtype_id):
    py_value = value
    types = gtype_and_ctype_of(gtype_id)
    gtype, ctype, ctg = types
    if gtype and ctype:
        if gtype.is_a(GObject.TYPE_OBJECT):
            py_value = _PyGO_CAPI.to_object(value)
        elif gtype.is_a(GObject.TYPE_GTYPE):
            py_value = gtype
        elif gtype.is_a(GObject.TYPE_STRING):
            py_value = ctype(value).value.decode('utf-8')
        elif ctg == INT:
            py_value = ctype(value).value
        elif ctg == ADDRESS:
            py_value = ctype.from_address(value)
    return py_value, gtype, ctype, ctg


def c_to_py(value, gtype_id):
    return from_int(value, gtype_id)[0]


###############################################################################
# GeeIterator
###############################################################################

class _GeeIterator(object):
    def __init__(self, obj, it):
        self.it = it
        self.obj = obj
        self.size = None
        if hasattr(obj, 'get_size'):
            self.size = obj.get_size()

    def __iter__(self):
        it = self.it
        while it and it.has_next():
            it.next()
            yield it
        raise StopIteration


class GeeListIterator(_GeeIterator):
    def __init__(self, obj):
        _GeeIterator.__init__(self, obj, obj.iterator())

        self.key_type = GObject.GType.from_name('gint')
        self.value_type = None

        if hasattr(obj, 'get_element_type'):
            self.value_type = obj.get_element_type()

    def __iter__(self):
        i = 0
        for it in _GeeIterator.__iter__(self):
            value = it.get()

            if self.value_type:
                value = c_to_py(value, self.value_type)

            yield i, value
            i += 1


class GeeMapIterator(_GeeIterator):
    def __init__(self, obj):
        _GeeIterator.__init__(self, obj, obj.map_iterator())

        self.key_type = None
        self.value_type = None

        if hasattr(obj, 'get_key_type'):
            self.key_type = obj.get_key_type()

        if hasattr(obj, 'get_value_type'):
            self.value_type = obj.get_value_type()

    def __iter__(self):
        for it in _GeeIterator.__iter__(self):
            key = it.get_key()
            value = it.get_value()

            if self.key_type:
                key = c_to_py(key, self.key_type)

            if self.value_type:
                value = c_to_py(value, self.value_type)

            yield key, value


def get_iterator(obj):
    if hasattr(obj, "map_iterator"):
        return GeeMapIterator(obj)
    if hasattr(obj, "iterator"):
        return GeeListIterator(obj)
    return []


###############################################################################
# Folks
###############################################################################

class PhoneFieldDetailsWrapper(object):
    def __init__(self, obj):
        self.field_details = obj
        self.value_type = obj.get_value_type()
        self.value = c_to_py(obj.get_value(), self.value_type)
        params = get_iterator(obj.get_parameters())
        self.parameters = {}

        while (params.it.next()):
            key = c_to_py(params.it.get_key(), params.key_type)
            value = c_to_py(params.it.get_value(), params.value_type)
            self.parameters[key] = value


class FolksListener(object):
    def __init__(self, loop):
        self.loop = loop
        self.cache_dir = os.path.expanduser("~/.cache/gsconnect/contacts/")
        self.cache_path = os.path.join(self.cache_dir, "contacts.json")

        try:
            with open(self.cache_path, 'r') as cache_file:
                self.cache = json.load(cache_file);
        except:
            self.cache = []

        self.aggregator = Folks.IndividualAggregator.dup()
        self.aggregator.connect('notify::is-quiescent', self._on_quiescent)
        self.aggregator.prepare()

    def _on_quiescent(self, *args):
        new_cache = []

        for folk in self.get_folks():
            for phone_number in self.get_phone_numbers(folk):
                new_contact = {
                    'name': folk.get_display_name(),
                    'number': phone_number.value,
                    'type': phone_number.parameters.get('type', 'unknown'),
                    'origin': 'folks'
                }

                avatar = folk.get_avatar()

                if avatar != None:
                    if hasattr(avatar, 'get_file'):
                        new_contact['avatar'] = avatar.get_file().get_path()
                    elif hasattr(avatar, 'get_bytes'):
                        folk_id = folk.get_id() or GLib.uuid_string_random()
                        path = os.path.join(self.cache_dir, folk_id + ".jpeg")

                        with open(path, 'wb') as fobj:
                            fobj.write(avatar.get_bytes().get_data())

                        new_contact['avatar'] = path

                new_cache.append(new_contact)

        self.write(new_cache)
        self.loop.quit()

    def get_folks(self):
        individuals = self.aggregator.get_individuals()

        for uid, folk in get_iterator(individuals):
            yield folk

    def get_phone_numbers(self, folk):
        phone_numbers = folk.get_phone_numbers()

        for key, details in get_iterator(phone_numbers):
            yield PhoneFieldDetailsWrapper(details)

    def write(self, new_cache):
        # if new_cache is empty goa might not be running, avoid wiping contacts
        if not new_cache:
            return

        # update contacts
        new_diffs = list(itertools.filterfalse(lambda x: x in self.cache, new_cache))

        for old_item in self.cache:
            old_num = ''.join(re.findall(r'\d+', old_item['number']))

            for new_item in new_diffs:
                new_num = ''.join(re.findall(r'\d+', new_item['number']))

                if old_item['name'] in ('', new_item['name']) and old_num == new_num:
                    self.cache[self.cache.index(old_item)].update(new_item)
                    new_diffs.remove(new_item)

        # remove old folks
        old_diffs = list(itertools.filterfalse(lambda x: x in new_cache, self.cache))

        for old_item in old_diffs:
            if old_item['origin'] != 'kdeconnect':
                self.cache.remove(old_item);

        # add new folks
        for new_item in new_diffs:
            self.cache.append(new_item)

        with open(self.cache_path, 'w') as cache_file:
            json.dump(new_cache, cache_file)


###############################################################################
# main
###############################################################################

if __name__ == '__main__':
    loop = GObject.MainLoop()

    FolksListener(loop)

    loop.run()

