#ifndef MEM_H_
#define MEM_H_

#include "common.h"

/**
 * Like a nodejs buffer, but thread safe
 */
class Buf
{
public:

    Buf()
        : _data(0)
        , _len(0)
    {
    }

    explicit Buf(int len)
        : _alloc(new Alloc(len))
        , _data(_alloc->data())
        , _len(_alloc->length())
    {
    }

    explicit Buf(int len, uint8_t fill)
        : _alloc(new Alloc(len))
        , _data(_alloc->data())
        , _len(_alloc->length())
    {
        memset(_data, fill, _len);
    }

    explicit Buf(void* data, int len)
        : _alloc(0)
        , _data(reinterpret_cast<uint8_t*>(data))
        , _len(len)
    {
    }

    explicit Buf(const void* data, int len)
        : _alloc(0)
        , _data(reinterpret_cast<uint8_t*>(const_cast<void*>(data)))
        , _len(len)
    {
    }

    Buf(const Buf& other)
    {
        init(other);
    }

    Buf(const Buf& other, int offset, int len)
    {
        init(other);
        slice(offset, len);
    }

    // copyful concat
    template <typename Iter>
    Buf(int len, Iter begin, Iter end)
        : _alloc(new Alloc(len))
        , _data(_alloc->data())
        , _len(_alloc->length())
    {
        uint8_t* data = _data;
        while (len > 0) {
            assert(begin != end);
            int now = std::min<int>(len, begin->length());
            memcpy(data, begin->data(), now);
            data += now;
            len -= now;
            begin++;
        }
    }

    ~Buf()
    {
    }

    const Buf& operator=(const Buf& other)
    {
        init(other);
        return other;
    }

    inline uint8_t* data()
    {
        return _data;
    }

    inline const uint8_t* data() const
    {
        return _data;
    }

    inline char* cdata()
    {
        return reinterpret_cast<char*>(_data);
    }

    inline const char* cdata() const
    {
        return reinterpret_cast<const char*>(_data);
    }

    inline int length() const
    {
        return _len;
    }

    inline uint8_t& operator[](int i)
    {
        return _data[i];
    }

    inline const uint8_t& operator[](int i) const
    {
        return _data[i];
    }

    inline void slice(int offset, int len)
    {
        // skip to offset
        if (offset > _len) {
            offset = _len;
        }
        if (offset < 0) {
            offset = 0;
        }
        _data += offset;
        _len -= offset;
        // truncate to length
        if (_len > len) {
            _len = len;
        }
        if (_len < 0) {
            _len = 0;
        }
    }

    inline void reset()
    {
        _data = _alloc->data();
        _len = _alloc->length();
    }

    // detach the allocated memory back to the responsibility of the caller
    inline uint8_t* detach_alloc()
    {
        return _alloc->detach();
    }

    inline bool unique_alloc()
    {
        return _alloc.unique();
    }

    inline std::string hex() const
    {
        std::string str;
        for (int i=0; i<_len; ++i) {
            str += BYTE_TO_HEX[_data[i]];
        }
        return str;
    }

    inline bool same(const Buf& buf) const
    {
        return (_len == buf._len) && (0 == memcmp(_data, buf._data, _len));
    }

private:

    class Alloc
    {
private:
        uint8_t* _data;
        int _len;
public:
        explicit Alloc(int len)
            : _data(new uint8_t[len])
            , _len(len)
        {
        }
        explicit Alloc(void* data, int len)
            : _data(reinterpret_cast<uint8_t*>(data))
            , _len(len)
        {
        }
        explicit Alloc(const void* data, int len)
            : _data(reinterpret_cast<uint8_t*>(const_cast<void*>(data)))
            , _len(len)
        {
        }
        Alloc(const Alloc& other)
            : _data(new uint8_t[other._len])
            , _len(other._len)
        {
            memcpy(_data, other._data, _len);
        }
        ~Alloc()
        {
            delete[] _data;
        }
        inline uint8_t* data()
        {
            return _data;
        }
        inline char* cdata()
        {
            return reinterpret_cast<char*>(_data);
        }
        inline int length()
        {
            return _len;
        }
        // detach the allocated memory to the responsibility of the caller
        inline uint8_t* detach()
        {
            uint8_t* data = _data;
            _data = NULL;
            _len = 0;
            return data;
        }
    };

    void init(const Buf& other)
    {
        _alloc = other._alloc;
        _data = other._data;
        _len = other._len;
    }

    static const char* BYTE_TO_HEX[256];

    std::shared_ptr<Alloc> _alloc;
    uint8_t* _data;
    int _len;
};

#endif // MEM_H_
