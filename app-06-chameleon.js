// Huddle app-06-chameleon.js (fragment 6/10, split from app.js).
// All fragments share ONE global scope and MUST load in numeric order — do not reorder.

    // ============================================================
    // THE CHAMELEON — separate state + game loop, no shared code paths with Hot Seat
    // ============================================================
    //
    // Single-device prototype convention: meId is hardcoded (Jordan). Other players are NPCs
    // we simulate. Voting behaviour is randomised with light bias toward realistic outcomes
    // (50% of non-Chameleon NPCs vote for the actual Chameleon; the Chameleon NPC votes for
    // a random Player to throw suspicion).
    //
    // When real multiplayer ships, replace NPC simulation with synced peer votes; the UI
    // flow does not need to change.

    // Topics + items. Translations live in the data structure (not as i18n keys) — saves a
    // huge amount of i18n bloat. Topic NAMES are i18n keyed though.
    //
    // DESIGN RULE: each topic is a TIGHT semantic family — every item in the grid belongs to
    // the same narrow type (e.g., all dog breeds, all pizza toppings, all musical instruments).
    // This is what makes Chameleon hard. With loose mixed categories (mammals + fish + bugs),
    // the Chameleon can bluff with a generic word like "wild" and stay safe. With tight
    // categories, every hint MUST be specific — and any vague hint exposes the Chameleon.
    // Matches the published Big Potato Chameleon convention (Pizza Toppings, Disney Villains,
    // Things in a Toolbox, etc.).
    //
    // Each topic carries 32 items. chamStartRound shuffles the pool and takes 16 so the 4×4
    // grid feels fresh even when the same topic repeats. Names that are universally
    // recognized stay in English in the TR list too (superhero names, Disney characters) —
    // same convention used in Hot Seat's WORDS.
    const CHAM_TOPICS = {
      dogs: {
        emoji: '🐕',
        en: ['Husky','Poodle','Bulldog','Labrador','Beagle','Boxer','Dalmatian','Chihuahua','Pug','Shepherd','Retriever','Doberman','Rottweiler','Collie','Spaniel','Greyhound','Mastiff','Akita','Corgi','Pomeranian','Schnauzer','Setter','Terrier','Whippet','Kangal','Bichon','Basset','Bloodhound','Pinscher','Yorkie','Maltese','Dachshund'],
        tr: ['Husky','Kaniş','Bulldog','Labrador','Beagle','Boxer','Dalmaçyalı','Chihuahua','Pug','Çoban köpeği','Golden','Doberman','Rottweiler','Collie','Spaniel','Tazı','Mastiff','Akita','Corgi','Pomeranya','Schnauzer','Setter','Terrier','Whippet','Kangal','Bichon','Basset','Bloodhound','Pinscher','Yorkie','Maltese','Dachshund'],
      },
      zoo: {
        emoji: '🦁',
        en: ['Lion','Tiger','Elephant','Giraffe','Zebra','Hippo','Rhino','Bear','Panda','Gorilla','Chimpanzee','Monkey','Kangaroo','Koala','Penguin','Crocodile','Cheetah','Leopard','Jaguar','Wolf','Fox','Lemur','Meerkat','Otter','Seal','Walrus','Sloth','Camel','Ostrich','Polar bear','Buffalo','Orangutan'],
        tr: ['Aslan','Kaplan','Fil','Zürafa','Zebra','Su aygırı','Gergedan','Ayı','Panda','Goril','Şempanze','Maymun','Kanguru','Koala','Penguen','Timsah','Çita','Leopar','Jaguar','Kurt','Tilki','Lemur','Mirket','Su samuru','Fok','Mors','Tembel','Deve','Devekuşu','Kutup ayısı','Bufalo','Orangutan'],
      },
      sea: {
        emoji: '🐠',
        en: ['Shark','Dolphin','Whale','Octopus','Squid','Crab','Lobster','Jellyfish','Starfish','Seahorse','Eel','Stingray','Turtle','Seal','Walrus','Pufferfish','Clownfish','Tuna','Salmon','Cod','Sardine','Anchovy','Swordfish','Manta ray','Orca','Beluga','Manatee','Coral','Sea urchin','Narwhal','Shrimp','Oyster'],
        tr: ['Köpekbalığı','Yunus','Balina','Ahtapot','Kalamar','Yengeç','Istakoz','Denizanası','Denizyıldızı','Denizatı','Yılan balığı','Vatoz','Kaplumbağa','Fok','Mors','Balon balığı','Palyaço balığı','Ton balığı','Somon','Morina','Sardalya','Hamsi','Kılıç balığı','Manta','Orka','Beluga','Manati','Mercan','Deniz kestanesi','Narval','Karides','İstiridye'],
      },
      birds: {
        emoji: '🦅',
        en: ['Eagle','Owl','Parrot','Penguin','Sparrow','Pigeon','Hawk','Falcon','Crow','Raven','Robin','Swan','Duck','Goose','Chicken','Rooster','Turkey','Peacock','Flamingo','Pelican','Heron','Stork','Vulture','Woodpecker','Hummingbird','Canary','Cockatoo','Toucan','Kiwi','Ostrich','Emu','Albatross'],
        tr: ['Kartal','Baykuş','Papağan','Penguen','Serçe','Güvercin','Şahin','Doğan','Karga','Kuzgun','Kızılgerdan','Kuğu','Ördek','Kaz','Tavuk','Horoz','Hindi','Tavus','Flamingo','Pelikan','Balıkçıl','Leylek','Akbaba','Ağaçkakan','Sinekkuşu','Kanarya','Kakadu','Tukan','Kivi','Devekuşu','Emu','Albatros'],
      },
      farm: {
        emoji: '🐔',
        en: ['Cow','Sheep','Goat','Horse','Pig','Chicken','Duck','Goose','Rooster','Donkey','Mule','Lamb','Calf','Piglet','Foal','Bull','Ox','Buffalo','Turkey','Rabbit','Llama','Alpaca','Pony','Boar','Ram','Ewe','Stallion','Mare','Kid','Quail','Hen','Drake'],
        tr: ['İnek','Koyun','Keçi','At','Domuz','Tavuk','Ördek','Kaz','Horoz','Eşek','Katır','Kuzu','Buzağı','Domuz yavrusu','Tay','Boğa','Öküz','Manda','Hindi','Tavşan','Lama','Alpaka','Midilli','Yaban domuzu','Koç','Dişi koyun','Aygır','Kısrak','Oğlak','Bıldırcın','Piliç','Erkek ördek'],
      },
      pizza: {
        emoji: '🍕',
        en: ['Pepperoni','Mushroom','Onion','Olive','Cheese','Ham','Pineapple','Sausage','Bacon','Tomato','Anchovy','Spinach','Pepper','Chicken','Tuna','Garlic','Basil','Salami','Corn','Egg','Beef','Artichoke','Broccoli','Jalapeño','Feta','Mozzarella','Eggplant','Zucchini','Pesto','Capers','Parmesan','Ricotta'],
        tr: ['Sucuk','Mantar','Soğan','Zeytin','Peynir','Jambon','Ananas','Sosis','Pastırma','Domates','Hamsi','Ispanak','Biber','Tavuk','Ton balığı','Sarımsak','Fesleğen','Salam','Mısır','Yumurta','Dana eti','Enginar','Brokoli','Jalapeño','Beyaz peynir','Mozzarella','Patlıcan','Kabak','Pesto','Kapari','Parmesan','Ricotta'],
      },
      fruits: {
        emoji: '🍎',
        en: ['Apple','Banana','Orange','Strawberry','Watermelon','Pineapple','Grape','Mango','Peach','Pear','Plum','Cherry','Lemon','Lime','Kiwi','Coconut','Avocado','Papaya','Apricot','Blueberry','Raspberry','Blackberry','Pomegranate','Fig','Melon','Guava','Lychee','Passion fruit','Persimmon','Quince','Tangerine','Date'],
        tr: ['Elma','Muz','Portakal','Çilek','Karpuz','Ananas','Üzüm','Mango','Şeftali','Armut','Erik','Kiraz','Limon','Misket limonu','Kivi','Hindistan cevizi','Avokado','Papaya','Kayısı','Yaban mersini','Ahududu','Böğürtlen','Nar','İncir','Kavun','Guava','Liçi','Çarkıfelek','Trabzon hurması','Ayva','Mandalina','Hurma'],
      },
      veggies: {
        emoji: '🥬',
        en: ['Carrot','Potato','Tomato','Onion','Garlic','Pepper','Cucumber','Lettuce','Spinach','Broccoli','Cauliflower','Cabbage','Pumpkin','Eggplant','Zucchini','Mushroom','Corn','Pea','Bean','Radish','Beet','Celery','Asparagus','Artichoke','Leek','Okra','Turnip','Parsnip','Kale','Arugula','Chard','Fennel'],
        tr: ['Havuç','Patates','Domates','Soğan','Sarımsak','Biber','Salatalık','Marul','Ispanak','Brokoli','Karnabahar','Lahana','Bal kabağı','Patlıcan','Kabak','Mantar','Mısır','Bezelye','Fasulye','Turp','Pancar','Kereviz','Kuşkonmaz','Enginar','Pırasa','Bamya','Şalgam','Yaban havucu','Karalahana','Roka','Pazı','Rezene'],
      },
      desserts: {
        emoji: '🍰',
        en: ['Cake','Cookie','Donut','Ice cream','Brownie','Cupcake','Cheesecake','Tiramisu','Pie','Tart','Muffin','Pudding','Mousse','Pancake','Waffle','Crepe','Eclair','Macaron','Croissant','Baklava','Cannoli','Truffle','Soufflé','Sundae','Sorbet','Gelato','Custard','Trifle','Parfait','Pavlova','Crumble','Fudge'],
        tr: ['Pasta','Kurabiye','Donut','Dondurma','Brownie','Cupcake','Cheesecake','Tiramisu','Turta','Tart','Muffin','Puding','Mus','Pankek','Waffle','Krep','Ekler','Makaron','Kruvasan','Baklava','Cannoli','Truffle','Sufle','Sundae','Sorbet','Gelato','Krema','Trifle','Parfe','Pavlova','Crumble','Fudge'],
      },
      drinks: {
        emoji: '☕',
        en: ['Coffee','Tea','Cola','Juice','Water','Lemonade','Smoothie','Milkshake','Hot chocolate','Espresso','Cappuccino','Latte','Iced tea','Mocha','Frappe','Soda','Beer','Wine','Whiskey','Vodka','Cocktail','Champagne','Cider','Rum','Gin','Tequila','Sake','Margarita','Mojito','Sangria','Ayran','Lassi'],
        tr: ['Kahve','Çay','Kola','Meyve suyu','Su','Limonata','Smoothie','Milkshake','Sıcak çikolata','Espresso','Cappuccino','Latte','Soğuk çay','Mocha','Frappe','Soda','Bira','Şarap','Viski','Votka','Kokteyl','Şampanya','Elma şarabı','Rom','Cin','Tekila','Sake','Margarita','Mojito','Sangria','Ayran','Lassi'],
      },
      turkish: {
        emoji: '🥙',
        en: ['Kebab','Köfte','Lahmacun','Pide','Baklava','Künefe','Dolma','Mantı','Börek','Simit','Menemen','Çiğ köfte','İskender','Adana','Urfa','Lokum','Pilav','Mercimek','Sarma','Tarhana','Tantuni','Su böreği','Sucuk','Pastırma','Helva','Tulumba','Şekerpare','Revani','Ayran','Salep','Boza','Tahini'],
        tr: ['Kebap','Köfte','Lahmacun','Pide','Baklava','Künefe','Dolma','Mantı','Börek','Simit','Menemen','Çiğ köfte','İskender','Adana','Urfa','Lokum','Pilav','Mercimek','Sarma','Tarhana','Tantuni','Su böreği','Sucuk','Pastırma','Helva','Tulumba','Şekerpare','Revani','Ayran','Salep','Boza','Tahin'],
      },
      breakfast: {
        emoji: '🍳',
        en: ['Eggs','Bacon','Toast','Pancakes','Cereal','Omelet','Sausage','Bagel','Croissant','Waffles','French toast','Yogurt','Granola','Oatmeal','Muffin','Donut','Hash browns','Porridge','Smoothie','Crepes','Quiche','Frittata','Scone','Honey','Jam','Butter','Cheese','Olives','Tomato','Cucumber','Tea','Coffee'],
        tr: ['Yumurta','Pastırma','Tost','Pankek','Mısır gevreği','Omlet','Sosis','Simit','Kruvasan','Waffle','Fransız tost','Yoğurt','Granola','Yulaf ezmesi','Muffin','Donut','Patates kızartması','Lapa','Smoothie','Krep','Kiş','Frittata','Çörek','Bal','Reçel','Tereyağı','Peynir','Zeytin','Domates','Salatalık','Çay','Kahve'],
      },
      disney: {
        emoji: '🏰',
        en: ['Mickey','Minnie','Donald','Goofy','Pluto','Simba','Nala','Mufasa','Scar','Ariel','Belle','Beast','Cinderella','Aurora','Snow White','Elsa','Anna','Olaf','Moana','Mulan','Rapunzel','Tiana','Jasmine','Aladdin','Pocahontas','Tarzan','Hercules','Pinocchio','Bambi','Dumbo','Peter Pan','Tinkerbell'],
        tr: ['Mickey','Minnie','Donald','Goofy','Pluto','Simba','Nala','Mufasa','Scar','Ariel','Belle','Beast','Cinderella','Aurora','Snow White','Elsa','Anna','Olaf','Moana','Mulan','Rapunzel','Tiana','Jasmine','Aladdin','Pocahontas','Tarzan','Hercules','Pinocchio','Bambi','Dumbo','Peter Pan','Tinkerbell'],
      },
      heroes: {
        emoji: '🦸',
        en: ['Superman','Batman','Spider-Man','Iron Man','Hulk','Thor','Wonder Woman','Captain America','Black Panther','Flash','Aquaman','Wolverine','Deadpool','Daredevil','Ant-Man','Doctor Strange','Hawkeye','Black Widow','Captain Marvel','Storm','Cyclops','Jean Grey','Green Lantern','Robin','Catwoman','Joker','Loki','Thanos','Venom','Magneto','Nightwing','Supergirl'],
        tr: ['Superman','Batman','Spider-Man','Iron Man','Hulk','Thor','Wonder Woman','Captain America','Black Panther','Flash','Aquaman','Wolverine','Deadpool','Daredevil','Ant-Man','Doctor Strange','Hawkeye','Black Widow','Captain Marvel','Storm','Cyclops','Jean Grey','Green Lantern','Robin','Catwoman','Joker','Loki','Thanos','Venom','Magneto','Nightwing','Supergirl'],
      },
      ballsports: {
        emoji: '⚽',
        en: ['Football','Basketball','Tennis','Volleyball','Baseball','Cricket','Rugby','Golf','Bowling','Handball','Badminton','Squash','Polo','Snooker','Pool','Hockey','Field hockey','Beach volley','Netball','Lacrosse','Pingpong','Dodgeball','Kickball','Softball','Water polo','Ultimate','Pickleball','Boules','Petanque','Croquet','Foosball','Bocce'],
        tr: ['Futbol','Basketbol','Tenis','Voleybol','Beyzbol','Kriket','Ragbi','Golf','Bowling','Hentbol','Badminton','Squash','Polo','Snooker','Bilardo','Hokey','Çim hokeyi','Plaj voleybolu','Netbol','Lakros','Pingpong','Dodgeball','Kickball','Softbol','Su topu','Frizbi','Pickleball','Boules','Petanque','Kroket','Langırt','Bocce'],
      },
      olympic: {
        emoji: '🥋',
        en: ['Swimming','Boxing','Karate','Judo','Wrestling','Marathon','Archery','Sailing','Diving','Climbing','Skating','Skiing','Snowboard','Gymnastics','Cycling','Rowing','Fencing','Taekwondo','Pole vault','Long jump','High jump','Sprint','Hurdles','Discus','Javelin','Shot put','Triathlon','Decathlon','Equestrian','Surfing','Skateboard','Weightlift'],
        tr: ['Yüzme','Boks','Karate','Judo','Güreş','Maraton','Okçuluk','Yelken','Dalış','Tırmanış','Paten','Kayak','Snowboard','Jimnastik','Bisiklet','Kürek','Eskrim','Tekvando','Sırıkla atlama','Uzun atlama','Yüksek atlama','Sprint','Engelli koşu','Disk','Cirit','Gülle','Triatlon','Dekatlon','Binicilik','Sörf','Kaykay','Halter'],
      },
      instruments: {
        emoji: '🎸',
        en: ['Guitar','Piano','Drums','Violin','Flute','Trumpet','Saxophone','Harmonica','Accordion','Banjo','Harp','Cello','Clarinet','Trombone','Oboe','Bassoon','Bagpipes','Mandolin','Ukulele','Xylophone','Tambourine','Maracas','Triangle','Bongo','Sitar','Lute','Recorder','Synth','Keyboard','Bass','Organ','Castanets'],
        tr: ['Gitar','Piyano','Davul','Keman','Flüt','Trompet','Saksafon','Mızıka','Akordeon','Banjo','Arp','Çello','Klarnet','Trombon','Obua','Fagot','Gayda','Mandolin','Ukulele','Ksilofon','Tef','Marakas','Üçgen','Bongo','Sitar','Lavta','Blok flüt','Synth','Klavye','Bas','Org','Kastanyet'],
      },
      hospital: {
        emoji: '🏥',
        en: ['Doctor','Nurse','Surgeon','Dentist','Pharmacist','Therapist','Paramedic','Midwife','Vet','Physio','Psychologist','Psychiatrist','Radiologist','Cardiologist','Pediatrician','Oncologist','Anesthetist','Optometrist','Orthodontist','Chiropractor','Nutritionist','Receptionist','Caregiver','Counselor','Intern','Resident','Pathologist','Dermatologist','Neurologist','Lab tech','Specialist','Orderly'],
        tr: ['Doktor','Hemşire','Cerrah','Diş hekimi','Eczacı','Terapist','Paramedik','Ebe','Veteriner','Fizyoterapist','Psikolog','Psikiyatrist','Radyolog','Kardiyolog','Çocuk doktoru','Onkolog','Anestezist','Göz doktoru','Ortodontist','Kiropraktör','Diyetisyen','Resepsiyonist','Bakıcı','Danışman','Stajyer','Asistan','Patolog','Dermatolog','Nörolog','Lab teknisyeni','Uzman','Hasta bakıcı'],
      },
      trades: {
        emoji: '🔧',
        en: ['Plumber','Electrician','Carpenter','Mechanic','Builder','Welder','Painter','Bricklayer','Tiler','Roofer','Locksmith','Glazier','Blacksmith','Mason','Cobbler','Tailor','Barber','Florist','Baker','Butcher','Sculptor','Potter','Watchmaker','Goldsmith','Upholsterer','Plasterer','Joiner','Cooper','Jeweler','Chimney sweep','Stonemason','Gardener'],
        tr: ['Tesisatçı','Elektrikçi','Marangoz','Tamirci','İnşaatçı','Kaynakçı','Boyacı','Duvarcı','Fayansçı','Çatıcı','Çilingir','Camcı','Demirci','Taşçı','Ayakkabıcı','Terzi','Berber','Çiçekçi','Fırıncı','Kasap','Heykeltıraş','Çömlekçi','Saatçi','Kuyumcu','Döşemeci','Sıvacı','Doğramacı','Fıçıcı','Mücevherci','Baca temizleyici','Mermerci','Bahçıvan'],
      },
      landmarks: {
        emoji: '🗼',
        en: ['Eiffel Tower','Big Ben','Pyramids','Taj Mahal','Colosseum','Statue of Liberty','Mt Everest','Niagara','Grand Canyon','Hagia Sophia','Blue Mosque','Topkapı','Galata Tower','Burj Khalifa','Sphinx','Great Wall','Stonehenge','Acropolis','Parthenon','Machu Picchu','Christ Redeemer','Sydney Opera','Tower Bridge','Notre Dame','Sagrada Família','Leaning Tower','Petra','Angkor Wat','Mt Fuji','White House','Kremlin','Sahara'],
        tr: ['Eyfel Kulesi','Big Ben','Piramitler','Tac Mahal','Kolezyum','Özgürlük Heykeli','Everest','Niagara','Grand Canyon','Ayasofya','Sultanahmet','Topkapı','Galata Kulesi','Burj Khalifa','Sfenks','Çin Seddi','Stonehenge','Akropol','Parthenon','Machu Picchu','Kurtarıcı İsa','Sidney Operası','Kule Köprü','Notre Dame','Sagrada Família','Pisa Kulesi','Petra','Angkor Wat','Fuji Dağı','Beyaz Saray','Kremlin','Sahra'],
      },
      kitchen: {
        emoji: '🍴',
        en: ['Fork','Knife','Spoon','Plate','Cup','Pan','Pot','Whisk','Ladle','Spatula','Bowl','Mug','Cutting board','Strainer','Grater','Peeler','Tongs','Apron','Mixer','Blender','Toaster','Kettle','Oven','Stove','Fridge','Microwave','Dishwasher','Sink','Napkin','Tray','Rolling pin','Salt shaker'],
        tr: ['Çatal','Bıçak','Kaşık','Tabak','Bardak','Tava','Tencere','Çırpıcı','Kepçe','Spatula','Kase','Kupa','Kesme tahtası','Süzgeç','Rende','Soyacak','Maşa','Önlük','Mikser','Blender','Tost makinesi','Su ısıtıcısı','Fırın','Ocak','Buzdolabı','Mikrodalga','Bulaşık makinesi','Lavabo','Peçete','Tepsi','Oklava','Tuzluk'],
      },
      clothes: {
        emoji: '👕',
        en: ['Shirt','Pants','Dress','Hat','Shoes','Socks','Jeans','Jacket','Coat','Scarf','Gloves','Boots','Sneakers','Sandals','Skirt','Shorts','Sweater','Hoodie','Suit','Tie','Belt','T-shirt','Underwear','Pajamas','Robe','Cap','Beanie','Glasses','Watch','Earrings','Necklace','Ring'],
        tr: ['Gömlek','Pantolon','Elbise','Şapka','Ayakkabı','Çorap','Kot','Ceket','Mont','Atkı','Eldiven','Bot','Spor ayakkabı','Sandalet','Etek','Şort','Kazak','Kapüşonlu','Takım','Kravat','Kemer','Tişört','İç çamaşırı','Pijama','Bornoz','Kep','Bere','Gözlük','Kol saati','Küpe','Kolye','Yüzük'],
      },
    };
    const CHAM_TOPIC_IDS = Object.keys(CHAM_TOPICS);

    // Game state — kept completely separate from Hot Seat's `state`. Reset on every lobby open.
    const chamState = {
      topic: 'mixed',          // 'mixed' | 'animals' | 'foods' | ...
      rounds: 3,               // 1 | 3 | 5
      currentRound: 1,
      players: [],             // deep-copied from PLAYERS at lobby open
      chameleonId: null,
      previousChameleonId: null,
      activeTopic: null,       // resolved topic for this round (never 'mixed')
      gridItems: [],           // 16 strings for this round, in the active language
      secretIndex: -1,         // index into gridItems of the secret word
      startingPlayerIdx: 0,
      myVote: null,            // playerId I (meId) voted for — kept for per-device locking
      voteResults: {},         // playerId → array of voter playerIds (real votes only)
      mostVotedId: null,       // playerId(s) with the highest vote count — picks chameleon first if tied
      chameleonCaught: false,
      outcome: null,           // 'chameleon' | 'players'
      scores: {},              // playerId → wins across rounds in this game
      // Multiplayer additions (mirror hotState)
      code: null,
      phase: 'lobby',          // 'lobby' | 'splash' | 'play' | 'vote' | 'result'
      hostId: null,
      claimedBy: {},           // playerId → sessionId
      revision: 0,
    };

    // Local per-device identity for Chameleon (mirrors hotMe)
    const chamMe = { sessionId: null, myId: null, bootstrapped: false };

    async function chamBootstrap(){ return huddleBootstrap(chamMe); }
    function chamGetSessionId(){ return huddleGetSessionId(chamMe); }
    function chamIsHost(){ return chamGetSessionId() === chamState.hostId; }
    function chamClaimedCount(){ return Object.keys(chamState.claimedBy || {}).length; }

    // ---------- Chameleon sync transport (mirrors hotPersist/hotLoadRoom/hotWireSync) ----------
    function chamPersist(){
      if (!chamState.code) return;
      chamState.revision = (chamState.revision || 0) + 1;
      if (!window.sb) return;
      const snapshot = JSON.parse(JSON.stringify(chamState));
      window.sb
        .from('chameleon_rooms')
        .upsert({ code: snapshot.code, state: snapshot })
        .then(({ error }) => {
          if (error) {
            console.warn('[Huddle] cham persist failed:', error.message || error);
            try { if (typeof showLobbyToast === 'function') showLobbyToast(t('common.syncFailed'), 3500); } catch(e){}
          }
        }, (err) => {
          console.warn('[Huddle] cham persist network error:', err && err.message || err);
          try { if (typeof showLobbyToast === 'function') showLobbyToast(t('common.syncFailed'), 3500); } catch(e){}
        });
    }
    async function chamLoadRoom(code){
      const incoming = await huddleFetchRoomState('chameleon_rooms', code);
      if (!incoming) return false;
      if (incoming.closedByHost) return false;   // room closed by host — treat as gone
      Object.keys(chamState).forEach(k => { delete chamState[k]; });
      Object.assign(chamState, incoming);
      return true;
    }
    // ===== Chameleon multiplayer presence =====
    // Supabase Presence tracks every device subscribed to the room channel.
    // When a tab dies (OS kill, wifi drop, app switch-away), the WebSocket
    // eventually drops and Supabase emits a `presence.leave`. A 5-second grace
    // timer covers legitimate refreshes (auth user ID is stable across reload).
    // After the grace expires, the lowest-connected peer fires
    // huddle_cham_handle_disconnect server-side, which does phase-aware cleanup
    // (seat removal, host transfer, round abort if the chameleon left mid-game).
    let _chamPresentSessions = new Set();
    let _chamLeaveGraceTimers = new Map();
    // 60s grace — long enough to cover a player locking their phone briefly,
    // switching to another app, or hitting a transient network drop. Was
    // originally 5s which freed seats so aggressively that legitimate
    // "I'll be right back" moments dropped players from the lobby.
    // Matches industry default for soft-disconnect windows (Colyseus
    // documents 30s; we go slightly higher since Huddle is in-person and
    // hosts/friends can verbally call a kick if it drags on).
    const CHAM_LEAVE_GRACE_MS = 60000;

    function chamIsPlayerPresent(playerId){
      if (!playerId) return false;
      const sid = chamState.claimedBy && chamState.claimedBy[playerId];
      return sid ? _chamPresentSessions.has(sid) : false;
    }
    // Lowest-seat-id remaining player whose session is currently connected.
    // Deterministic across peers, so the "who fires the cleanup mutation"
    // decision is consistent without a coordinator.
    function chamLowestSeatConnectedPlayer(){
      const claimedBy = chamState.claimedBy || {};
      const seats = Object.keys(claimedBy).sort();
      for (const pid of seats) {
        const sid = claimedBy[pid];
        if (sid && _chamPresentSessions.has(sid)) return pid;
      }
      return null;
    }
    function chamConfirmUserGone(sessionId){
      _chamPresentSessions.delete(sessionId);
      _chamLeaveGraceTimers.delete(sessionId);
      let goneSeatId = null;
      Object.keys(chamState.claimedBy || {}).forEach(pid => {
        if (chamState.claimedBy[pid] === sessionId) goneSeatId = pid;
      });
      if (!goneSeatId) {
        if (typeof chamRerender === 'function') chamRerender();
        return;
      }
      // Only the lowest-connected peer fires the server cleanup — others just refresh UI.
      const isMyJobToWrite = chamLowestSeatConnectedPlayer() === chamMe.myId;
      if (!isMyJobToWrite) {
        if (typeof chamRerender === 'function') chamRerender();
        return;
      }
      chamHandleConfirmedDisconnect(goneSeatId);
    }
    function chamHandleConfirmedDisconnect(goneSeatId){
      // Note: the "{name} left" toast is now emitted by the realtime sync handler
      // (seat-vanish detection), which fires for BOTH explicit Leave and
      // disconnect — so it's intentionally NOT shown here (would double-toast).

      const goneSessionId = chamState.claimedBy && chamState.claimedBy[goneSeatId];
      if (!goneSessionId) {
        if (typeof chamRerender === 'function') chamRerender();
        return;
      }
      huddleCallRPC('huddle_cham_handle_disconnect', {
        p_code: chamState.code,
        p_gone_session_id: goneSessionId,
      });
    }
    function chamStartLeaveGrace(sessionId){ huddleStartLeaveGrace(_chamLeaveGraceTimers, sessionId, CHAM_LEAVE_GRACE_MS, chamConfirmUserGone); }
    function chamCancelLeaveGrace(sessionId){ huddleCancelLeaveGrace(_chamLeaveGraceTimers, sessionId); }
    function chamResetPresenceState(){ huddleResetPresenceState(_chamLeaveGraceTimers, _chamPresentSessions);
    }

    let _chamChannel = null;
    let _chamChannelCode = null;
    let _chamChannelSessionId = null;
    function chamWireSync(){
      if (!window.sb) return;
      if (!chamState.code) return;
      // Bind the channel to BOTH the room code AND the current session id.
      // The presence key is captured at channel-creation time (see below), so a
      // user-identity change (e.g., anon → Google sign-in) requires a rebuild
      // — otherwise our presence echoes the stale anon id.
      const sid = chamGetSessionId();
      if (_chamChannel && _chamChannelCode === chamState.code && _chamChannelSessionId === sid) return;
      if (_chamChannel) {
        try { window.sb.removeChannel(_chamChannel); } catch(e){}
        _chamChannel = null; _chamChannelCode = null; _chamChannelSessionId = null;
        chamResetPresenceState();
      }
      const code = chamState.code;
      const handler = (payload) => {
        const newState = payload && payload.new && payload.new.state;
        if (!newState) return;
        if (typeof newState.revision === 'number' && newState.revision <= (chamState.revision || 0)) return;
        // Host closed the room — auto-leave for every other player still seated.
        if (newState.closedByHost && chamMe.myId) {
          if (typeof showLobbyToast === 'function') {
            try { showLobbyToast(t('lobby.hostClosedRoom'), 3500); } catch(e){}
          }
          chamForceLeaveLocal();
          return;
        }
        // Preserve myVote — it's per-device only (not shared)
        const localMyVote = chamState.myVote;
        // Capture seating BEFORE applying — detect a player leaving (explicit
        // Leave OR disconnect both surface here as a vanished seat) for the
        // "{name} left" notice + graceful end. Parity with Hot Seat.
        const _prevClaimedBy = Object.assign({}, chamState.claimedBy || {});
        const _prevPhase = chamState.phase;
        const _mySidNow = chamGetSessionId();
        Object.keys(chamState).forEach(k => { delete chamState[k]; });
        Object.assign(chamState, newState);
        // Restore meId from claim so existing code reading state.meId still works
        const sid = chamGetSessionId();
        const claimed = Object.entries(chamState.claimedBy || {}).find(([pid, s]) => s === sid);
        if (claimed) { chamMe.myId = claimed[0]; state.meId = claimed[0]; }
        // ----- Player-left notice + graceful end (parity with Hot Seat) -----
        try {
          if (chamMe.myId) {
            const _newClaimedBy = chamState.claimedBy || {};
            const _goneSeats = Object.keys(_prevClaimedBy).filter(pid =>
              _prevClaimedBy[pid] && !_newClaimedBy[pid] && _prevClaimedBy[pid] !== _mySidNow);
            if (_goneSeats.length && typeof showLobbyToast === 'function') {
              const p = (chamState.players || []).find(x => x.id === _goneSeats[0]);
              let nm; try { nm = (p && typeof playerDisplayFor === 'function') ? playerDisplayFor(p, _prevClaimedBy).name : (p && p.name); } catch(e){}
              showLobbyToast(t('cham.toastPlayerLeft', { name: nm || (p && p.name) || '?' }), 3500);
            }
            const _wasMid = _prevPhase && _prevPhase !== 'lobby' && _prevPhase !== 'result';
            const _stillMid = chamState.phase && chamState.phase !== 'lobby' && chamState.phase !== 'result';
            if (_wasMid && _stillMid && Object.keys(_newClaimedBy).length < 2 && chamIsHost()) {
              try { if (typeof showLobbyToast === 'function') showLobbyToast(t('cham.otherPlayerLeft'), 3500); } catch(e){}
              chamState.phase = 'lobby';
              chamPersist();
            }
          }
        } catch(e){}
        // Restore myVote if we've already voted in this round
        if (chamMe.myId && chamState.voteResults) {
          const myVotedFor = Object.keys(chamState.voteResults).find(target =>
            (chamState.voteResults[target] || []).includes(chamMe.myId)
          );
          if (myVotedFor) chamState.myVote = myVotedFor;
        }
        const activeId = document.querySelector('.screen.active');
        const currentId = activeId ? activeId.id.replace('screen-', '') : null;
        const chamScreens = ['cham-lobby','cham-splash','cham-play','cham-vote','cham-result'];
        if (currentId && chamScreens.indexOf(currentId) !== -1) chamRerender();
      };
      // Presence-event handlers. Key is the auth session id so refresh = same key.
      const onPresenceSync = () => {
        const state = _chamChannel.presenceState();
        const fresh = new Set(Object.keys(state || {}));
        // Anyone newly arrived clears their grace timer (refresh covers this).
        fresh.forEach(sid => {
          if (_chamLeaveGraceTimers.has(sid)) chamCancelLeaveGrace(sid);
        });
        _chamPresentSessions = fresh;
        if (typeof chamRerender === 'function') chamRerender();
      };
      const onPresenceJoin = ({ key }) => {
        if (!key) return;
        _chamPresentSessions.add(key);
        chamCancelLeaveGrace(key);
      };
      const onPresenceLeave = ({ key }) => {
        if (!key) return;
        // DON'T delete from _chamPresentSessions immediately — start a grace
        // timer so a refresh-rejoin (~1-3s) doesn't trigger the "left" flow.
        chamStartLeaveGrace(key);
      };
      _chamChannelCode = code;
      _chamChannelSessionId = sid;
      _chamChannel = window.sb
        .channel('chameleon_room:' + code, { config: { presence: { key: chamMe.sessionId || ('tab_' + Math.random()) } } })
        .on('postgres_changes', { event:'UPDATE', schema:'public', table:'chameleon_rooms', filter:'code=eq.' + code }, handler)
        .on('postgres_changes', { event:'INSERT', schema:'public', table:'chameleon_rooms', filter:'code=eq.' + code }, handler)
        .on('presence', { event: 'sync'  }, onPresenceSync)
        .on('presence', { event: 'join'  }, onPresenceJoin)
        .on('presence', { event: 'leave' }, onPresenceLeave)
        .subscribe(async (status) => {
          if (status !== 'SUBSCRIBED') return;
          if (_chamChannelCode !== code) return;
          // Announce our presence the moment we're subscribed.
          try {
            await _chamChannel.track({
              user_id: chamMe.sessionId,
              joined_at: Date.now(),
            });
          } catch(e){}
          // Reconcile gap between initial load and live subscription.
          try {
            const ok = await chamLoadRoom(code);
            if (ok) {
              const sid = chamGetSessionId();
              const claimed = Object.entries(chamState.claimedBy || {}).find(([pid, s]) => s === sid);
              if (claimed) { chamMe.myId = claimed[0]; state.meId = claimed[0]; }
              const activeId = document.querySelector('.screen.active');
              const currentId = activeId ? activeId.id.replace('screen-', '') : null;
              if (currentId && ['cham-lobby','cham-splash','cham-play','cham-vote','cham-result'].indexOf(currentId) !== -1) chamRerender();
            }
          } catch(e){}
        });
    }
    // Chameleon rerender — wrapped through the generic sync gate. See the
    // huddleSync* block for the mechanism.
    function chamRerenderInner(){
      const phaseToScreen = { lobby:'cham-lobby', splash:'cham-splash', play:'cham-play', vote:'cham-vote', result:'cham-result' };
      const target = phaseToScreen[chamState.phase] || 'cham-lobby';
      const activeId = document.querySelector('.screen.active');
      const currentId = activeId ? activeId.id.replace('screen-', '') : null;
      if (currentId !== target) goTo(target);
      // Lobby-only invite sheet — auto-close if game starts while it's open.
      if (chamState.phase !== 'lobby') {
        const bd = document.getElementById('lobby-invite-backdrop');
        if (bd && bd.classList.contains('active') && typeof closeLobbyInviteSheet === 'function') {
          closeLobbyInviteSheet();
        }
      }
      if (chamState.phase === 'lobby') { renderChamLobbyPlayers(); chamRenderSettings(); chamUpdateHowToTrigger(); if (typeof renderLobbyInvites === 'function') renderLobbyInvites('chameleon'); }
      else if (chamState.phase === 'splash') applyChamSplashContent();
      else if (chamState.phase === 'play') applyChamPlayContent();
      else if (chamState.phase === 'vote') applyChamVoteContent();
      else if (chamState.phase === 'result') applyChamResultContent();
    }
    const __chamRerenderPending = { timer: null };
    function chamRerender(){
      huddleSyncGateRerender(chamState, chamRerenderInner, __chamRerenderPending);
    }

    function chamJoinUrl(code){ return joinUrl(code, 'chameleon'); }
    function chamReadUrlRoom(){ return huddleReadUrlRoom('chameleon'); }
    function chamSyncUrlToRoom(code){ huddleSyncUrlToRoom(code, 'chameleon'); }
    function chamFindRecentRoomCode(){
      try { return huddleReadLastRoom('cham'); } catch(e){ return null; }
    }
    async function chamStateReset(code){
      const playersCopy = JSON.parse(JSON.stringify(PLAYERS));
      const scoresInit = {};
      playersCopy.forEach(p => { scoresInit[p.id] = 0; });
      const sid = chamGetSessionId();
      const firstSeat = playersCopy[0] && playersCopy[0].id;
      Object.keys(chamState).forEach(k => { delete chamState[k]; });
      Object.assign(chamState, {
        topic: 'mixed',
        rounds: 3,
        currentRound: 1,
        players: playersCopy,
        chameleonId: null,
        previousChameleonId: null,
        activeTopic: null,
        gridItems: [],
        secretIndex: -1,
        startingPlayerIdx: 0,
        myVote: null,
        voteResults: {},
        mostVotedId: null,
        chameleonCaught: false,
        outcome: null,
        scores: scoresInit,
        code: code,
        phase: 'lobby',
        // Pre-claim seat 0 for the creator (see hotStateReset for reasoning).
        // Single atomic write closes the race where an invitee could load the
        // room mid-create and steal the host role or seat 0.
        hostId: sid,
        claimedBy: firstSeat ? { [firstSeat]: sid } : {},
        revision: 0,
      });
      chamMe.myId = firstSeat || null;
      if (firstSeat) state.meId = firstSeat;
      chamPersist();
      try { huddlePersistLastRoom('cham',code); } catch(e){}
    }
    async function chamClaimSeat(playerId){
      const sessionId = chamGetSessionId();
      const currentClaim = chamState.claimedBy[playerId];
      if (currentClaim && currentClaim !== sessionId) return;
      // Optimistic local update; server-validated via universal RPC (C2 turn 5).
      if (chamMe.myId && chamState.claimedBy[chamMe.myId] === sessionId) {
        delete chamState.claimedBy[chamMe.myId];
      }
      chamState.claimedBy[playerId] = sessionId;
      if (!chamState.hostId) chamState.hostId = sessionId;
      chamMe.myId = playerId;
      state.meId = playerId;
      renderChamLobbyPlayers();
      chamRenderSettings();
      await huddleCallRPC('huddle_claim_seat', {
        p_table: 'chameleon_rooms',
        p_code: chamState.code,
        p_player_id: playerId,
      });
    }
    async function chamAutoClaimIfNeeded(){
      if (chamMe.myId) return;
      if (chamState.phase && chamState.phase !== 'lobby') return;
      const empty = (chamState.players || []).find(p => !chamState.claimedBy || !chamState.claimedBy[p.id]);
      if (!empty) return;
      await chamClaimSeat(empty.id);
    }

    // ---------- Lobby ----------
    async function openChamLobby(){
      // Drop any seat we still hold in OTHER game lobbies before claiming
      // one here — invariant: one user, one seat across all games.
      try { huddleLeaveOtherGameSeats('cham'); } catch(e){}
      const urlRoom = chamReadUrlRoom();
      const existingCode = urlRoom || chamFindRecentRoomCode();

      const authPromise = chamBootstrap();
      const loadPromise = existingCode ? chamLoadRoom(existingCode) : Promise.resolve(false);
      await authPromise;
      const sessionId = chamGetSessionId();
      const loaded = await loadPromise;

      // Invitee arrived via URL but the room load failed — surface it and
      // route to Games instead of silently creating a fresh room.
      if (urlRoom && !loaded) {
        try { history.replaceState(history.state, '', '/'); } catch(e){}
        if (typeof showLobbyToast === 'function') {
          try { showLobbyToast(t('lobby.joinFailed')); } catch(e){}
        }
        goTo('games');
        return;
      }

      let cachedRoomGone = !!existingCode && !loaded;

      if (loaded) {
        const claimed = Object.entries(chamState.claimedBy || {}).find(([pid, sid]) => sid === sessionId);
        chamMe.myId = claimed ? claimed[0] : null;
        if (chamMe.myId) {
          state.meId = chamMe.myId;
          try { huddlePersistLastRoom('cham',existingCode); } catch(e){}
        } else if (urlRoom) {
          // Intentional join via URL/invite — keep the cached code.
          try { huddlePersistLastRoom('cham',existingCode); } catch(e){}
        } else {
          // Cached room but we have no claim and no invite — don't barge in.
          try { huddleClearLastRoom('cham'); } catch(e){}
          await chamStateReset(generateCode());
          cachedRoomGone = true;
        }

        // === Reconnect protection (mirrors openLiarLobby) ===
        // If we returned to a room that's mid-game (splash / play / vote) but
        // we no longer own a seat, bounce to Games instead of stranding the
        // user on a screen they can't act on. See openLiarLobby for full
        // rationale on why this happens.
        const inGamePhase = chamState.phase
          && chamState.phase !== 'lobby'
          && chamState.phase !== 'result';
        if (inGamePhase && !chamMe.myId) {
          if (typeof showLobbyToast === 'function') {
            try { showLobbyToast(t('liar.toastReconnectStale'), 4500); } catch(e){}
          }
          chamForceLeaveLocal();
          return;
        }
      } else {
        await chamStateReset(generateCode());
      }

      chamWireSync();
      await chamAutoClaimIfNeeded();
      chamSyncUrlToRoom(chamState.code);

      document.getElementById('cham-room-code').textContent = chamState.code;
      const fallback = document.getElementById('cham-room-qr-fallback');
      if (fallback) fallback.classList.remove('show');
      setRoomQrSrc(document.getElementById('cham-room-qr'), qrUrl(chamJoinUrl(chamState.code)));

      chamUpdateHowToTrigger();
      chamRerender();

      if (cachedRoomGone && typeof showLobbyToast === 'function') {
        showLobbyToast(t('lobby.previousRoomGone'));
      }
    }

    async function regenerateChamRoom(){
      const code = generateCode();
      await chamStateReset(code);
      chamWireSync();
      chamSyncUrlToRoom(code);
      const codeEl = document.getElementById('cham-room-code');
      const fallback = document.getElementById('cham-room-qr-fallback');
      if (codeEl) codeEl.textContent = code;
      if (fallback) fallback.classList.remove('show');
      setRoomQrSrc(document.getElementById('cham-room-qr'), qrUrl(chamJoinUrl(code)));
      const btn = document.querySelector('#screen-cham-lobby .room-code-action button[onclick*="regenerateChamRoom"]');
      if (btn) {
        btn.classList.remove('spinning');
        void btn.offsetWidth;
        btn.classList.add('spinning');
        setTimeout(() => btn.classList.remove('spinning'), 520);
      }
      chamRerender();
    }

    function handleChamQrError(){
      const img = document.getElementById('cham-room-qr');
      const fallback = document.getElementById('cham-room-qr-fallback');
      if (img) img.style.display = 'none';
      if (fallback) fallback.classList.add('show');
    }

    // Settings render — Topic picker (single tap-to-open row mirroring Hot Seat's Category)
    // and Rounds segmented control. No "Order" or "Mode" — Chameleon doesn't need them.
    function chamRenderSettings(){
      const list = document.getElementById('cham-settings-list');
      if (!list) return;
      const roundsSeg = [1,3,5].map(r =>
        `<button onclick="chamSetRounds(${r})" class="${chamState.rounds===r?'active':''}">${r}</button>`
      ).join('');
      const topicLabel = chamState.topic === 'mixed' ? t('cham.topic.mixed') : t('cham.topic.' + chamState.topic);
      list.innerHTML = `
        <div class="setting-row" onclick="openChamTopicSheet()" style="cursor:pointer">
          <div class="setting-row-label">${t('cham.topicLabel')}</div>
          <div style="display:flex;align-items:center;gap:6px;color:var(--text-secondary);font-size:14px">
            <span>${topicLabel}</span>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--text-tertiary)"><path d="m9 18 6-6-6-6"></path></svg>
          </div>
        </div>
        <div class="setting-row">
          <div class="setting-row-label">${t('lobby.rounds')}</div>
          <div class="seg">${roundsSeg}</div>
        </div>
      `;
    }

    function chamSetRounds(r){
      if (!chamIsHost()) return;
      chamState.rounds = r;
      huddleCallRPC('huddle_cham_set_setting', { p_code: chamState.code, p_field: 'rounds', p_value: r });
      chamRenderSettings();
    }
    function chamSetTopic(topicId){
      if (!chamIsHost()) return;
      chamState.topic = topicId;
      huddleCallRPC('huddle_cham_set_setting', { p_code: chamState.code, p_field: 'topic', p_value: topicId });
      chamRenderSettings();
    }

    // Real-multiplayer seat-claim lobby render (mirrors renderLobbyPlayers in Hot Seat)
    function renderChamLobbyPlayers(){
      const grid = document.getElementById('cham-players-grid');
      if (grid && huddleLobbyHydrating(chamState && chamState.code)) {
        grid.innerHTML = huddleLobbySkeletonHTML(6);
        return;
      }
      if (!grid) return;
      const sessionId = chamGetSessionId();
      const claimedCount = chamClaimedCount();
      const claimedSessionIds = Object.values(chamState.claimedBy || {});
      ensureClaimantProfiles(claimedSessionIds, renderChamLobbyPlayers);
      // Prefer @username (unique) over display_name first-word so two players
      // with the same first name render distinctly. See claimDisplayName.
      const myName = (myProfile && myProfile.username)
        ? '@' + myProfile.username
        : ((myProfile && myProfile.name && myProfile.name.trim().split(/\s+/)[0]) || t('lobby.seatYou'));
      const myAvatar = (myProfile && myProfile.avatar) ? myProfile.avatar : null;
      grid.innerHTML = chamState.players.map((p, i) => {
        const claimedSession = chamState.claimedBy && chamState.claimedBy[p.id];
        const claimedByMe = claimedSession === sessionId;
        const claimedByOther = !!claimedSession && !claimedByMe;
        const isHostSeat = !!claimedSession && claimedSession === chamState.hostId;
        const claimProfile = claimedByOther ? profileForClaim(claimedSession) : null;

        // Empty seat → invite tile (shared lobby invite sheet).
        if (!claimedSession) {
          return `
            <div class="player-tile hot-seat-tile invite-tile" onclick="openLobbyInviteSheet('chameleon')">
              <span class="invite-plus" aria-hidden="true">+</span>
              <div class="player-tile-name" data-i18n="liar.seatInviteTap">Invite friend</div>
              <div class="player-tile-status" data-i18n="liar.seatEmpty">Empty seat</div>
            </div>
          `;
        }

        let cls = 'player-tile hot-seat-tile';
        let statusText, nameText, avatarData;
        if (claimedByMe) {
          cls += ' claimed-by-me';
          nameText = myName;
          statusText = isHostSeat ? t('lobby.host') : t('lobby.seatYou');
          avatarData = myAvatar || avatarForPlayer(p);
        } else {
          cls += ' claimed-by-other';
          nameText = claimDisplayName(claimProfile, '…');
          statusText = isHostSeat ? t('lobby.host') : t('lobby.seatTaken');
          avatarData = (claimProfile && claimProfile.avatar) ? claimProfile.avatar : avatarForPlayer(p);
        }
        const avatar = avatarHTML(avatarData, 32, { online: true, fallback: p.initial });
        return `
          <div class="${cls}">
            ${avatar}
            <div class="player-tile-name">${escapeHTML(nameText)}</div>
            <div class="player-tile-status">${escapeHTML(statusText)}</div>
          </div>
        `;
      }).join('');
      parseEmoji(grid);
      if (typeof applyLang === 'function') applyLang();

      const title = document.getElementById('cham-players-title');
      if (title) title.textContent = t('lobby.playersCount', { count: claimedCount });

      const hint = document.getElementById('cham-seats-hint');
      const startBtn = document.getElementById('cham-start-btn');
      const amHost = chamIsHost();
      if (hint) {
        if (!chamMe.myId) hint.textContent = t('lobby.seatsHintNotPicked');
        else if (claimedCount < 3) hint.textContent = t('lobby.seatsHintNeedMore', { n: 3 - claimedCount });
        else if (!amHost) hint.textContent = t('lobby.seatsHintWaitingHost');
        else hint.textContent = t('lobby.seatsHintReady');
      }
      if (startBtn) {
        const canStart = claimedCount >= 3 && !!chamMe.myId && amHost;
        if (canStart) startBtn.removeAttribute('aria-disabled');
        else          startBtn.setAttribute('aria-disabled', 'true');
      }
      const leaveBtn = document.getElementById('cham-leave-btn');
      const hasSeat = !!chamMe.myId;
      if (leaveBtn) leaveBtn.hidden = !hasSeat;
      if (typeof refreshLobbyInviteSheetIfOpen === 'function') refreshLobbyInviteSheetIfOpen('chameleon');
    }
    // Back-compat alias — older callers (e.g. applyLang) still reach for chamRenderPlayers
    function chamRenderPlayers(){ renderChamLobbyPlayers(); }

    async function chamLeaveRoom(context){
      return huddleLeaveRoom({
        meObj: chamMe, gameState: chamState, sidFn: chamGetSessionId,
        table: 'chameleon_rooms', gameToken: 'chameleon', lastRoomKey: 'cham', context,
        teardown: () => {
          // Chameleon intentionally does NOT untrack before removeChannel.
          if (_chamChannel) {
            try { window.sb.removeChannel(_chamChannel); } catch(e){}
            _chamChannel = null; _chamChannelCode = null; _chamChannelSessionId = null;
            chamResetPresenceState();
          }
        },
      });
    }
    // Local-only cleanup (no Supabase write). Used when host closes the room
    // and when a non-host receives the "closedByHost" broadcast.
    function chamForceLeaveLocal(){
      chamMe.myId = null;
      if (chamState) chamState.code = null;
      try { huddleClearLastRoom('cham'); } catch(e){}
      if (_chamChannel) {
        try { window.sb.removeChannel(_chamChannel); } catch(e){}
        _chamChannel = null; _chamChannelCode = null; _chamChannelSessionId = null;
        chamResetPresenceState();
      }
      try { history.replaceState(history.state, '', '/'); } catch(e){}
      goTo('games');
    }
    // Host taps "Leave" on the game-over screen → close the whole room so
    // every other player auto-leaves too via Realtime.
    function chamCloseRoom(){
      if (!chamIsHost()) { chamLeaveGameOver(); return; }
      const closingCode = chamState.code;
      chamState.closedByHost = true;
      chamState.hostId = null;
      if (closingCode) {
        huddleCallRPC('huddle_close_room', { p_table: 'chameleon_rooms', p_code: closingCode });
      }
      chamForceLeaveLocal();
    }
    // Host taps "Play again" → reset and restart. Others sync to splash.
    function chamPlayAgain(){
      if (!chamIsHost()) return;
      const claimed = chamClaimedPlayers();
      if (claimed.length < 3) return;
      chamState.closedByHost = false;
      chamStartGame();
    }
    // No-confirm leave for the game-over screen (mirror of chamLeaveRoom).
    function chamLeaveGameOver(){
      const mySid = chamGetSessionId();
      const myPlayerId = chamMe.myId;
      const leavingCode = chamState.code;
      if (myPlayerId && chamState.claimedBy && chamState.claimedBy[myPlayerId] === mySid) {
        delete chamState.claimedBy[myPlayerId];
      }
      if (chamState.hostId === mySid) {
        const remaining = Object.entries(chamState.claimedBy || {})
          .sort((a, b) => a[0].localeCompare(b[0]));
        chamState.hostId = remaining.length ? remaining[0][1] : null;
      }
      if (leavingCode) {
        huddleCallRPC('huddle_leave_seat', { p_table: 'chameleon_rooms', p_code: leavingCode });
      }
      chamMe.myId = null;
      chamState.code = null;
      try { huddleClearLastRoom('cham'); } catch(e){}
      if (_chamChannel) {
        try { window.sb.removeChannel(_chamChannel); } catch(e){}
        _chamChannel = null; _chamChannelCode = null; _chamChannelSessionId = null;
        chamResetPresenceState();
      }
      try { history.replaceState(history.state, '', '/'); } catch(e){}
      goTo('games');
    }

    // ---------- Topic picker sheet ----------
    // Built lazily on first open and re-rendered each time so .active reflects current state.
    let chamTopicSheetCreated = false;
    function openChamTopicSheet(){
      if (!chamTopicSheetCreated) chamBuildTopicSheet();
      chamRenderTopicOptions();
      document.getElementById('cham-topic-backdrop').classList.add('active');
    }
    function closeChamTopicSheet(ev){
      if (ev && ev.target && ev.target.id && ev.target.id !== 'cham-topic-backdrop') return;
      const el = document.getElementById('cham-topic-backdrop');
      if (el) el.classList.remove('active');
    }
    function chamPickTopic(topicId){
      chamSetTopic(topicId);
      setTimeout(() => {
        const el = document.getElementById('cham-topic-backdrop');
        if (el) el.classList.remove('active');
      }, 140);
    }
    function chamBuildTopicSheet(){
      const wrap = document.createElement('div');
      wrap.className = 'sheet-backdrop';
      wrap.id = 'cham-topic-backdrop';
      wrap.onclick = (e) => closeChamTopicSheet(e);
      // Inline t() rather than data-i18n because applyLang() already ran on page load and
      // won't process this lazily-built fragment. We re-render title/sub each open below
      // (in chamRenderTopicOptions) so language switches still update them.
      wrap.innerHTML = `
        <div class="sheet" onclick="event.stopPropagation()" style="position:relative">
          <button class="icon-btn" onclick="closeChamTopicSheet()" aria-label="${t('common.close')}" style="position:absolute;top:8px;right:8px">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"></path></svg>
          </button>
          <div class="sheet-handle"></div>
          <div class="sheet-title" id="cham-topic-sheet-title">${t('cham.topicLabel')}</div>
          <div class="sheet-body" id="cham-topic-sheet-sub" style="margin-bottom:14px">${t('cham.topicSub')}</div>
          <div class="theme-options" id="cham-topic-options"></div>
        </div>
      `;
      document.body.appendChild(wrap);
      chamTopicSheetCreated = true;
    }
    function chamRenderTopicOptions(){
      const wrap = document.getElementById('cham-topic-options');
      if (!wrap) return;
      // Refresh title/sub on every open so language switches between opens land here too.
      const titleEl = document.getElementById('cham-topic-sheet-title');
      const subEl = document.getElementById('cham-topic-sheet-sub');
      if (titleEl) titleEl.textContent = t('cham.topicLabel');
      if (subEl) subEl.textContent = t('cham.topicSub');
      const topics = [
        { id: 'mixed',       emoji: '🎲' },
        { id: 'dogs',        emoji: CHAM_TOPICS.dogs.emoji },
        { id: 'zoo',         emoji: CHAM_TOPICS.zoo.emoji },
        { id: 'sea',         emoji: CHAM_TOPICS.sea.emoji },
        { id: 'birds',       emoji: CHAM_TOPICS.birds.emoji },
        { id: 'farm',        emoji: CHAM_TOPICS.farm.emoji },
        { id: 'pizza',       emoji: CHAM_TOPICS.pizza.emoji },
        { id: 'fruits',      emoji: CHAM_TOPICS.fruits.emoji },
        { id: 'veggies',     emoji: CHAM_TOPICS.veggies.emoji },
        { id: 'desserts',    emoji: CHAM_TOPICS.desserts.emoji },
        { id: 'drinks',      emoji: CHAM_TOPICS.drinks.emoji },
        { id: 'turkish',     emoji: CHAM_TOPICS.turkish.emoji },
        { id: 'breakfast',   emoji: CHAM_TOPICS.breakfast.emoji },
        { id: 'disney',      emoji: CHAM_TOPICS.disney.emoji },
        { id: 'heroes',      emoji: CHAM_TOPICS.heroes.emoji },
        { id: 'ballsports',  emoji: CHAM_TOPICS.ballsports.emoji },
        { id: 'olympic',     emoji: CHAM_TOPICS.olympic.emoji },
        { id: 'instruments', emoji: CHAM_TOPICS.instruments.emoji },
        { id: 'hospital',    emoji: CHAM_TOPICS.hospital.emoji },
        { id: 'trades',      emoji: CHAM_TOPICS.trades.emoji },
        { id: 'landmarks',   emoji: CHAM_TOPICS.landmarks.emoji },
        { id: 'kitchen',     emoji: CHAM_TOPICS.kitchen.emoji },
        { id: 'clothes',     emoji: CHAM_TOPICS.clothes.emoji },
      ];
      wrap.innerHTML = topics.map(o => `
        <button class="theme-option${chamState.topic === o.id ? ' active' : ''}" onclick="chamPickTopic('${o.id}')">
          <span class="theme-option-icon" style="background:var(--bg-subtle)">${o.emoji}</span>
          <span class="theme-option-text">
            <span class="theme-option-title">${t('cham.topic.' + o.id)}</span>
          </span>
          <svg class="theme-option-check" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"></path></svg>
        </button>
      `).join('');
      parseEmoji(wrap);
    }

    // ---------- How to play (4-slide animated modal, mirrors Hot Seat) ----------
    const CHAM_HOWTO_KEY = 'huddle.chamhowto.seen';
    const CHAM_HOWTO_TOTAL = 4;
    let chamHowtoCurrent = 1;
    let chamHowtoTimer = null;
    function chamUpdateHowToTrigger(){
      try {
        const seen = !!localStorage.getItem(CHAM_HOWTO_KEY);
        document.querySelectorAll('#cham-howto-trigger').forEach(t => t.classList.toggle('pulse', !seen));
      } catch(e){}
    }
    function openChamHowTo(){
      document.getElementById('cham-howto-modal').classList.add('active');
      document.body.style.overflow = 'hidden';
      try { localStorage.setItem(CHAM_HOWTO_KEY, '1'); } catch(e){}
      document.querySelectorAll('#cham-howto-trigger').forEach(t => t.classList.remove('pulse'));
      chamGoToSlide(1);
    }
    function closeChamHowTo(){
      document.getElementById('cham-howto-modal').classList.remove('active');
      document.body.style.overflow = '';
      chamStopAuto();
    }
    function chamGoToSlide(n){
      if (n < 1) n = 1;
      if (n > CHAM_HOWTO_TOTAL) { closeChamHowTo(); return; }
      chamHowtoCurrent = n;
      const root = document.getElementById('cham-howto-modal');
      root.querySelectorAll('.howto-slide').forEach(s => {
        s.classList.toggle('active', parseInt(s.dataset.slide) === n);
      });
      root.querySelectorAll('.howto-dot').forEach((d, i) => {
        d.classList.toggle('active', i + 1 === n);
      });
      const btn = document.getElementById('cham-howto-next-btn');
      if (btn) btn.textContent = (n === CHAM_HOWTO_TOTAL) ? t('howTo.startPlaying') : t('common.next');
      chamStartAuto();
    }
    function chamNextSlide(){ chamGoToSlide(chamHowtoCurrent + 1); }
    function chamStartAuto(){
      chamStopAuto();
      chamHowtoTimer = setTimeout(() => chamGoToSlide(chamHowtoCurrent + 1), HOWTO_DURATION);
    }
    function chamStopAuto(){
      if (chamHowtoTimer) { clearTimeout(chamHowtoTimer); chamHowtoTimer = null; }
    }

    // ---------- Game flow (real multiplayer) ----------
    function chamClaimedPlayers(){
      // Players whose seats have been claimed on a real device, in original order.
      return (chamState.players || []).filter(p => chamState.claimedBy && chamState.claimedBy[p.id]);
    }

    async function chamStartGame(ev){
      // Gate: aria-disabled means a Start condition isn't met. Surface the
      // hint as a toast instead of silently doing nothing.
      const _gateBtn = document.getElementById('cham-start-btn');
      if (_gateBtn && _gateBtn.getAttribute('aria-disabled') === 'true') {
        const _hintEl = document.getElementById('cham-seats-hint');
        const _msg = _hintEl && _hintEl.textContent && _hintEl.textContent.trim();
        if (_msg && typeof showLobbyToast === 'function') showLobbyToast(_msg);
        return;
      }
      // C2 turn 5: server resets game state + picks chameleon + starting
      // player atomically via huddle_cham_play_again. Client only provides
      // the topic + grid + secret (dictionary lives in JS).
      if (!chamIsHost()) return;
      const claimed = chamClaimedPlayers();
      if (claimed.length < 3) return;
      const { activeTopic, gridItems, secretIndex } = chamPickRoundContent();
      // Disable the start button while the RPC is in flight so a frustrated
      // double-tap doesn't try to start the game twice.
      const btn = (ev && ev.currentTarget) || document.getElementById('cham-start-btn');
      if (btn) { btn.disabled = true; btn.setAttribute('aria-busy','true'); }
      const res = await huddleCallRPC('huddle_cham_play_again', {
        p_code:         chamState.code,
        p_active_topic: activeTopic,
        p_grid_items:   gridItems,
        p_secret_index: secretIndex,
      });
      // On error, re-enable so retry works. On success, the realtime echo
      // navigates everyone to the next phase and the button leaves the DOM.
      if (res && res.error && btn && document.body.contains(btn)) {
        btn.disabled = false;
        btn.removeAttribute('aria-busy');
      }
    }

    // Pure helper: picks topic + builds grid + picks secret index using the
    // client-side CHAM_TOPICS dictionary. No mutation, no persist.
    function chamPickRoundContent(){
      const topicId = chamState.topic === 'mixed'
        ? CHAM_TOPIC_IDS[Math.floor(Math.random() * CHAM_TOPIC_IDS.length)]
        : chamState.topic;
      const lang = (typeof getLang === 'function') ? getLang() : 'en';
      const fullPool = CHAM_TOPICS[topicId][lang] || CHAM_TOPICS[topicId].en;
      const shuffled = fullPool.slice();
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = shuffled[i]; shuffled[i] = shuffled[j]; shuffled[j] = tmp;
      }
      const gridItems = shuffled.slice(0, 16);
      const secretIndex = Math.floor(Math.random() * gridItems.length);
      return { activeTopic: topicId, gridItems, secretIndex };
    }

    function chamStartRound(){
      // C2 turn 5: server picks chameleon + starting player atomically.
      // Client provides topic + grid + secret (dictionary lives in JS).
      // Called from chamNextRound for round-to-round transitions.
      if (!chamIsHost()) return;
      const claimed = chamClaimedPlayers();
      if (claimed.length < 3) return;
      const { activeTopic, gridItems, secretIndex } = chamPickRoundContent();
      huddleCallRPC('huddle_cham_start_round', {
        p_code:         chamState.code,
        p_active_topic: activeTopic,
        p_grid_items:   gridItems,
        p_secret_index: secretIndex,
      });
    }

    // applyChamSplashContent — sync-driven splash render (no longer goTo here; chamRerender does that)
    function applyChamSplashContent(){
      const meIsChameleon = chamState.chameleonId === state.meId;
      const emojiEl = document.getElementById('cham-splash-emoji');
      const labelEl = document.getElementById('cham-splash-label');
      const nameEl = document.getElementById('cham-splash-name');
      const roleEl = document.getElementById('cham-splash-role');
      const jobEl = document.getElementById('cham-splash-job');

      labelEl.textContent = t('cham.roundOf', { current: chamState.currentRound, total: chamState.rounds });
      // Job callout is the same neutral style regardless of role — text + emoji indicate role.
      jobEl.className = 'cham-splash-job';
      if (meIsChameleon) {
        emojiEl.textContent = '🦎';
        emojiEl.className = 'cham-splash-emoji cham-splash-chameleon';
        nameEl.textContent = t('cham.youAreChameleon');
        roleEl.textContent = '';
        jobEl.innerHTML = `
          <div class="cham-splash-job-label">🎯 ${t('cham.yourJobLabel')}</div>
          <div class="cham-splash-job-text">${t('cham.yourJobChameleon')}</div>
        `;
      } else {
        emojiEl.textContent = '👁️';
        emojiEl.className = 'cham-splash-emoji';
        nameEl.textContent = t('cham.youArePlayer');
        const secretWord = chamState.gridItems[chamState.secretIndex];
        roleEl.innerHTML = t('cham.secretIs', { word: '<strong>' + escapeHTML(secretWord) + '</strong>' });
        jobEl.innerHTML = `
          <div class="cham-splash-job-label">🎯 ${t('cham.yourJobLabel')}</div>
          <div class="cham-splash-job-text">${t('cham.yourJobPlayer')}</div>
        `;
      }
      parseEmoji(emojiEl);
      parseEmoji(jobEl);

      const splashSection = document.getElementById('screen-cham-splash');
      const splashEl = splashSection.querySelector('.splash');
      if (splashEl) {
        splashEl.style.animation = 'none';
        void splashEl.offsetWidth;
        splashEl.style.animation = '';
      }
    }

    // Host advances from splash → play (other devices follow via sync).
    function chamDismissSplash(){
      if (!chamIsHost()) return;
      // Server validates host + sets phase='play' (C2 turn 5).
      huddleCallRPC('huddle_cham_dismiss_splash', { p_code: chamState.code });
    }

    function applyChamPlayContent(){
      const meIsChameleon = chamState.chameleonId === state.meId;
      const topicId = chamState.activeTopic;
      document.getElementById('cham-play-header').textContent = t('cham.roundOf', { current: chamState.currentRound, total: chamState.rounds });
      document.getElementById('cham-topic-emoji').textContent = CHAM_TOPICS[topicId].emoji;
      document.getElementById('cham-topic-name').textContent = t('cham.topic.' + topicId);

      // Role banner — persistent reminder during the hint phase. Neutral style for both
       // roles; the text + emoji do the differentiation, no colour tint needed.
      const roleBannerEl = document.getElementById('cham-role-banner');
      if (roleBannerEl) {
        roleBannerEl.className = 'cham-role-banner';
        const emoji = meIsChameleon ? '🦎' : '👁️';
        const text = meIsChameleon ? t('cham.roleBannerChameleon') : t('cham.roleBannerPlayer');
        roleBannerEl.innerHTML = `<span class="cham-role-banner-emoji">${emoji}</span><span>${text}</span>`;
        parseEmoji(roleBannerEl);
      }

      // Grid — Chameleon sees all cells "blank", Players see the secret highlighted.
      const gridEl = document.getElementById('cham-play-grid');
      gridEl.innerHTML = chamState.gridItems.map((item, i) => {
        const isSecret = !meIsChameleon && i === chamState.secretIndex;
        return `<div class="cham-grid-cell ${isSecret ? 'secret' : ''}">${escapeHTML(item)}</div>`;
      }).join('');

      // Instruction — who starts + role-specific cue.
      ensureClaimantProfiles(Object.values(chamState.claimedBy || {}), applyChamPlayContent);
      const startingPlayer = chamState.players[chamState.startingPlayerIdx];
      const startingDisplay = playerDisplayFor(startingPlayer, chamState.claimedBy);
      const startsText = startingPlayer.id === state.meId
        ? t('cham.youStart')
        : t('cham.nameStarts', { name: startingDisplay.name });
      const roleCue = meIsChameleon ? t('cham.cueChameleon') : t('cham.cuePlayer');
      document.getElementById('cham-play-instruction').innerHTML = `
        <div class="cham-instruction-icon">${meIsChameleon ? '🦎' : '💬'}</div>
        <div><b>${escapeHTML(startsText)}</b><br>${roleCue}</div>
      `;
      parseEmoji(document.getElementById('cham-play-instruction'));
      parseEmoji(document.getElementById('cham-topic-emoji'));
    }

    // Host advances from play → vote (other devices follow via sync).
    function chamGoToVote(){
      if (!chamIsHost()) return;
      // Server validates host + clears voteResults + sets phase='vote' (C2 turn 5).
      huddleCallRPC('huddle_cham_go_to_vote', { p_code: chamState.code });
    }

    function applyChamVoteContent(){
      const grid = document.getElementById('cham-vote-grid');
      if (!grid) return;
      const myId = chamMe.myId;
      const claimed = chamClaimedPlayers();
      // Has this device already voted? Look up myId in voteResults.
      const myVotedFor = myId && chamState.voteResults
        ? Object.keys(chamState.voteResults).find(target =>
            (chamState.voteResults[target] || []).includes(myId))
        : null;
      const alreadyVoted = !!myVotedFor;
      // You can't vote for yourself.
      ensureClaimantProfiles(Object.values(chamState.claimedBy || {}), applyChamVoteContent);
      grid.innerHTML = claimed
        .filter(p => p.id !== myId)
        .map(p => {
          const selected = (chamState.myVote === p.id) || (myVotedFor === p.id);
          const onclick = alreadyVoted ? '' : `onclick="chamPickVote('${p.id}')"`;
          const tileDisplay = playerDisplayFor(p, chamState.claimedBy);
          return `
            <div class="cham-vote-tile${selected ? ' selected' : ''}${alreadyVoted ? ' locked' : ''}" ${onclick}>
              ${avatarHTML(tileDisplay.avatar, 44, { fallback: p.initial })}
              <div class="cham-vote-tile-name">${escapeHTML(tileDisplay.name)}</div>
            </div>
          `;
        }).join('');
      parseEmoji(grid);

      const submitBtn = document.getElementById('cham-vote-submit');
      if (submitBtn) {
        if (alreadyVoted) {
          const votedCount = Object.values(chamState.voteResults || {}).reduce((n, arr) => n + arr.length, 0);
          const total = claimed.length;
          submitBtn.disabled = true;
          submitBtn.textContent = t('lobby.seatsHintWaitingHost') /* fallback */;
          // Use a clearer text if cham.waitingForVotes is missing
          try {
            const w = t('cham.waitingForVotes', { n: total - votedCount });
            if (w && w !== 'cham.waitingForVotes') submitBtn.textContent = w;
            else submitBtn.textContent = 'Waiting for others… (' + votedCount + '/' + total + ')';
          } catch(e){
            submitBtn.textContent = 'Waiting for others… (' + votedCount + '/' + total + ')';
          }
        } else {
          submitBtn.disabled = !chamState.myVote;
          if (chamState.myVote) {
            const selectedPlayer = claimed.find(p => p.id === chamState.myVote);
            if (selectedPlayer) {
              const display = playerDisplayFor(selectedPlayer, chamState.claimedBy);
              submitBtn.textContent = t('cham.voteForName', { name: display.name });
            } else {
              submitBtn.textContent = t('cham.lockInVote');
            }
          } else {
            submitBtn.textContent = t('cham.lockInVote');
          }
        }
      }
    }

    function chamPickVote(playerId){
      if (!chamMe.myId) return;
      // If already voted, ignore.
      const already = chamState.voteResults && Object.keys(chamState.voteResults).some(target =>
        (chamState.voteResults[target] || []).includes(chamMe.myId));
      if (already) return;
      chamState.myVote = playerId;
      applyChamVoteContent();
    }

    // ---------- Vote submit — REAL multiplayer (no NPC simulation) ----------
    async function chamSubmitVote(){
      if (!chamMe.myId) return;
      if (!chamState.myVote) return;
      const already = chamState.voteResults && Object.keys(chamState.voteResults).some(target =>
        (chamState.voteResults[target] || []).includes(chamMe.myId));
      if (already) return;

      const target = chamState.myVote;
      // Server records vote + rejects duplicates + rejects self-vote (C2 turn 5).
      await huddleCallRPC('huddle_cham_submit_vote', {
        p_code: chamState.code,
        p_target_id: target,
      });
      // After server confirms vote, only the HOST checks "is this the last
      // vote?" and fires resolve_outcome. Fixes plan note #H11 (no-host-
      // guard race where multiple devices ran resolve and stomped scores).
      if (chamIsHost()) {
        const claimed = chamClaimedPlayers();
        const votedCount = Object.values(chamState.voteResults || {}).reduce((n, arr) => n + arr.length, 0);
        if (votedCount >= claimed.length) {
          huddleCallRPC('huddle_cham_resolve_outcome', { p_code: chamState.code });
        }
      }
      applyChamVoteContent();
    }

    // ---------- Resolution + scoring (real votes only) ----------
    function chamResolveOutcome(){
      // C2 turn 5: scoring + outcome computation moved server-side via
      // huddle_cham_resolve_outcome. This function is now host-only-gated
      // at the call site (in chamSubmitVote). Kept for any straggler caller.
      // Local lifetime bumpWins fires on the device whose user actually won
      // based on the canonical state once the echo arrives — handled in
      // applyChamResultContent which renders the result screen.
      if (!chamIsHost()) return;
      huddleCallRPC('huddle_cham_resolve_outcome', { p_code: chamState.code });
    }

    function applyChamResultContent(){
      const isLastRound = chamState.currentRound >= chamState.rounds;
      const chameleon = chamState.players.find(p => p.id === chamState.chameleonId);
      const secretWord = chamState.gridItems[chamState.secretIndex];
      const chameleonWon = chamState.outcome === 'chameleon';

      document.getElementById('cham-result-header').textContent = isLastRound
        ? t('cham.gameOver')
        : t('cham.roundComplete', { n: chamState.currentRound });

      const emojiEl = document.getElementById('cham-result-emoji');
      emojiEl.textContent = chameleonWon ? '🦎' : '🎉';
      parseEmoji(emojiEl);

      document.getElementById('cham-result-title').textContent = chameleonWon
        ? t('cham.chameleonWins')
        : t('cham.playersWin');

      ensureClaimantProfiles(Object.values(chamState.claimedBy || {}), applyChamResultContent);
      const chamDisplay = playerDisplayFor(chameleon, chamState.claimedBy);
      const chameleonIsMe = chameleon && chameleon.id === state.meId;
      const chameleonNameForCopy = chameleonIsMe ? t('picker.you') : chamDisplay.name;

      // Sub explains *why* — caught or not — using the chameleon's name. Two cases only now.
      const subText = !chamState.chameleonCaught
        ? t('cham.resultEscaped', { name: '<strong>' + escapeHTML(chameleonNameForCopy) + '</strong>' })
        : t('cham.resultCaught', { name: '<strong>' + escapeHTML(chameleonNameForCopy) + '</strong>' });
      document.getElementById('cham-result-sub').innerHTML = subText;

      document.getElementById('cham-result-secret').innerHTML = t('cham.theSecretWas', {
        word: '<b>' + escapeHTML(secretWord) + '</b>'
      });

      // Vote tally — only show CLAIMED players (real votes only).
      const claimedForTally = chamClaimedPlayers();
      const tallyEl = document.getElementById('cham-result-tally');
      if (tallyEl && chamState.voteResults) {
        const sortedTally = [...claimedForTally].sort((a, b) =>
          (chamState.voteResults[b.id]?.length || 0) - (chamState.voteResults[a.id]?.length || 0)
        );
        tallyEl.innerHTML = sortedTally.map(p => {
          const votes = chamState.voteResults[p.id]?.length || 0;
          const isCham = p.id === chamState.chameleonId;
          const voteKey = votes === 1 ? 'cham.voteCountOne' : 'cham.voteCount';
          const rowDisplay = playerDisplayFor(p, chamState.claimedBy);
          return `
            <div class="cham-tally-row ${isCham ? 'chameleon' : ''}">
              ${avatarHTML(rowDisplay.avatar, 32, { fallback: p.initial })}
              <div class="cham-tally-name">${p.id === state.meId ? t('picker.you') : escapeHTML(rowDisplay.name)}${isCham ? ' 🦎' : ''}</div>
              <div class="cham-tally-votes">${t(voteKey, { n: votes })}</div>
            </div>
          `;
        }).join('');
        parseEmoji(tallyEl);
      }

      // Leaderboard — claimed players only.
      const lb = document.getElementById('cham-leaderboard');
      const sorted = [...claimedForTally].sort((a, b) =>
        (chamState.scores[b.id] || 0) - (chamState.scores[a.id] || 0)
      );
      lb.innerHTML = sorted.map((p, i) => {
        const wins = chamState.scores[p.id] || 0;
        const isCrowned = i === 0 && isLastRound && wins > 0;
        const isMe = p.id === state.meId;
        const winsKey = wins === 1 ? 'cham.scoreWinsOne' : 'cham.scoreWins';
        const rowDisplay = playerDisplayFor(p, chamState.claimedBy);
        return `
          <div class="lb-row ${isCrowned ? 'winner' : ''}">
            <div class="lb-rank">${i+1}</div>
            ${avatarHTML(rowDisplay.avatar, 44, { fallback: p.initial })}
            <div class="lb-name">${isMe ? t('picker.you') : escapeHTML(rowDisplay.name)}</div>
            <div class="lb-score">${t(winsKey, { n: wins })}</div>
          </div>
        `;
      }).join('');
      parseEmoji(lb);

      // Next button + secondary Leave button — vary by phase + role.
      //   • Game over + host  → "Play again" + "Leave" (host-leave closes room for everyone)
      //   • Game over + other → "Waiting for host to start new game…" + "Leave" (just me)
      //   • Mid-round + host  → "Next round" + "Leave" (just me; transfers host)
      //   • Mid-round + other → "Waiting for host…" + "Leave" (just me)
      const nextBtn = document.getElementById('cham-next-btn');
      const leaveBtn = document.getElementById('cham-result-leave-btn');
      const amHost = chamIsHost();
      if (isLastRound) {
        if (amHost) {
          nextBtn.textContent = t('result.playAgain');
          nextBtn.onclick = chamPlayAgain;
          nextBtn.disabled = false;
          leaveBtn.textContent = t('result.leaveGame');
          leaveBtn.onclick = chamCloseRoom;
        } else {
          nextBtn.textContent = t('result.waitingForHostNewGame');
          nextBtn.onclick = null;
          nextBtn.disabled = true;
          leaveBtn.textContent = t('result.leaveGame');
          leaveBtn.onclick = chamLeaveGameOver;
        }
      } else if (amHost) {
        nextBtn.textContent = t('result.nextRound');
        nextBtn.onclick = chamNextRound;
        nextBtn.disabled = true;
        setTimeout(() => { nextBtn.disabled = false; }, 700);
        leaveBtn.textContent = t('result.leaveGame');
        leaveBtn.onclick = chamLeaveGameOver;
      } else {
        nextBtn.textContent = t('lobby.seatsHintWaitingHost');
        nextBtn.onclick = null;
        nextBtn.disabled = true;
        leaveBtn.textContent = t('result.leaveGame');
        leaveBtn.onclick = chamLeaveGameOver;
      }

      // Count a completed game once. Flag rides on synced state and is persisted
      // immediately so the realtime echo of the round-end persist doesn't wipe
      // the local flag (wipe-and-replace at line 12445 would otherwise restore
      // the pre-bump snapshot and re-trigger the bump via applyChamResultContent).
      if (isLastRound && !chamState._gamesPlayedCounted && typeof bumpGamesPlayed === 'function') {
        bumpGamesPlayed();
        chamState._gamesPlayedCounted = true;
        // Server-side flag set (C2 turn 5) so the realtime echo can't wipe it.
        huddleCallRPC('huddle_cham_mark_game_counted', { p_code: chamState.code });
      }
    }

    function chamNextRound(){
      if (!chamIsHost()) return;
      chamState.previousChameleonId = chamState.chameleonId;
      chamState.currentRound++;
      chamStartRound();
    }

