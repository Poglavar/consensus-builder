# Remaining junctions

Snapshot from the 2026-09-28 Valhalla citywide survey (zero skipped tiles). Saved candidate solutions count toward settled coverage; they have not been canonically promoted or deployed.

The previous 70-open snapshot missed inbound lanes left unconnected at otherwise part-settled junctions. The corrected pre-run baseline was 113 open groups of 21,806, with 1,193 undecided movements.

New inbound-lane pass: 55/70 target nodes have validated settled candidates (52 on the first pass, 3 on verified 30 m retries).
Shared centre-lane pass: 17/18 target nodes have validated settled candidates (12 on the first pass, 5 on verified 30 m retries).
Earlier timed-out junction retry: settled.

Each new settled candidate was checked for target completeness, new persisted errors, turn-restriction regressions, and newly unassigned eligible inbound lanes. A completed model job alone is not counted as settled. Remaining receiving-lane and unmarked multi-lane cases need direct road-marking or turn-tag evidence; no safe deterministic default was found.

The road-parcel classification endpoint on Valhalla returned HTTP 500 during these runs, so road-parcel fitting was unavailable. No parcel source table was changed.

Citywide: 57 open of 21806; 645 undecided movements.

1. Aleja Blaža Jurišića × Ulica križnog puta (osm-node:8562995809)
   31 lanes, 6 arms; 16.054215466666665, 45.832091633333334
   osm-node:8562995809: 3 road arms meet here; 1 of 3 approaches are still undecided (multi lane approach without turn lanes).

2. Aleja grabova × Aleja ruža × Dubrava × I. Retkovec × Četvrte Poljanice (osm-node:2710721536)
   57 lanes, 10 arms; 16.073746545454547, 45.82803271818182
   osm-node:2710721536: 3 road arms meet here; 2 of 3 approaches are still undecided (multi lane approach without turn lanes).

3. Aleja grada Bolonje (osm-node:11731412188)
   10 lanes, 3 arms; 15.8385887, 45.8156691
   osm-node:11731412188: 3 road arms meet here; lane-to-lane movements have not been inferred yet (multi lane approach without turn lanes).

4. Avenija Dubrovnik × Froudeova ulica × Siget (osm-node:1456152012)
   45 lanes, 9 arms; 15.97179482727273, 45.777068772727276
   osm-node:1456152012: 3 road arms meet here; 1 of 2 approaches are still undecided (unassigned incoming lane).

5. Avenija Dubrovnik × Stonska ulica (osm-node:299830654)
   61 lanes, 8 arms; 15.985641566666663, 45.77767730833333
   osm-node:299830654: 4 road arms meet here; lane-to-lane movements have not been inferred yet (multi lane approach without turn lanes).

6. Avenija Gojka Šuška (osm-node:10749445015)
   19 lanes, 8 arms; 16.0360407, 45.82530525
   osm-node:10749445015: 4 road arms meet here; 1 of 3 approaches are still undecided (unassigned incoming lane).

7. Avenija Gojka Šuška × Ulica Rudolfa Kolaka (osm-node:9239475679, osm-node:9239475680)
   22 lanes, 6 arms; 16.0341018, 45.83105363333334
   osm-node:9239475679: 4 road arms meet here; lane-to-lane movements have not been inferred yet (multi lane approach without turn lanes).
   osm-node:9239475680: 4 road arms meet here; lane-to-lane movements have not been inferred yet (receiving lane undetermined).

8. Avenija Gojka Šuška × Žuti breg (osm-node:11835615185)
   22 lanes, 7 arms; 16.0320456, 45.83853633333334
   osm-node:11835615185: 4 road arms meet here; 2 of 3 approaches are still undecided (receiving lane undetermined).

9. Avenija Marina Držića × Trg kralja Petra Krešimira IV. × Ulica kneza Branimira (osm-node:11918245253)
   40 lanes, 9 arms; 15.99254032, 45.80625452
   osm-node:11918245253: 4 road arms meet here; lane-to-lane movements have not been inferred yet (multi lane approach without turn lanes).

10. Avenija Većeslava Holjevca (osm-node:10025871223)
   28 lanes, 11 arms; 16.005423116666666, 45.73905705000001
   osm-node:10025871223: 4 road arms meet here; lane-to-lane movements have not been inferred yet (multi lane approach without turn lanes).

11. Avenija Većeslava Holjevca (osm-node:5277389298)
   39 lanes, 10 arms; 15.989404966666667, 45.75425403333333
   osm-node:5277389298: 4 road arms meet here; lane-to-lane movements have not been inferred yet (receiving lane undetermined).

12. Avenija Većeslava Holjevca × Ulica Damira Tomljanovića - Gavrana × Ulica Józsefa Antalla (osm-node:11958731801)
   59 lanes, 12 arms; 15.98011481666667, 45.78369708333333
   osm-node:11958731801: 4 road arms meet here; 1 of 6 approaches are still undecided (unassigned incoming lane).

13. Brestovečka ulica × Ulica Ljudevita Posavskog × Ulica Vladimira Kirina × Zagrebačka cesta (osm-node:1790474225)
   68 lanes, 11 arms; 16.09874912142857, 45.82799636428571
   osm-node:1790474225: 5 road arms meet here; 2 of 3 approaches are still undecided (ambiguous arm for turn).

14. Cvetkovačka ulica × Ulica Nikole Tesle (osm-node:1089113217)
   20 lanes, 6 arms; 15.643230525, 45.656713249999996
   osm-node:1089113217: 3 road arms meet here; 1 of 4 approaches are still undecided (unassigned incoming lane).

15. Drenovac × Jordanovac × Laščinska cesta (osm-node:3587447044)
   31 lanes, 6 arms; 15.99744797, 45.826893749999996
   osm-node:3587447044: 3 road arms meet here; 1 of 2 approaches are still undecided (multi lane approach without turn lanes).

16. Fallerovo šetalište × Ilirska ulica × Kostrenska ulica × Zagrebačka avenija (osm-node:1559827283)
   29 lanes, 7 arms; 15.936857199999999, 45.79377733333333
   osm-node:1559827283: 4 road arms meet here; 2 of 3 approaches are still undecided (restricted lane in multi lane approach).

17. Gruška ulica × Kruge (osm-node:583212852)
   17 lanes, 4 arms; 15.99162535, 45.794714625
   osm-node:583212852: 3 road arms meet here; 2 of 3 approaches are still undecided (receiving lane undetermined).

18. Horvaćanska cesta × Rudeška cesta (osm-node:20840672)
   35 lanes, 8 arms; 15.913809416666668, 45.79173583333334
   osm-node:20840672: 4 road arms meet here; 1 of 5 approaches are still undecided (unassigned incoming lane).

19. Horvaćanska cesta × Selska cesta (osm-node:20840602, osm-node:319243641)
   47 lanes, 11 arms; 15.945794200000003, 45.788251
   osm-node:20840602: 4 road arms meet here; lane-to-lane movements have not been inferred yet (receiving lane undetermined).
   osm-node:319243641: 4 road arms meet here; lane-to-lane movements have not been inferred yet (multi lane approach without turn lanes).

20. Hribarov prilaz × Ulica Mije Šiloboda Bolšića × Ulica Savezne Republike Njemačke (osm-node:319170498, osm-node:1575311283)
   38 lanes, 8 arms; 15.99086015, 45.764208800000006
   osm-node:319170498: 4 road arms meet here; lane-to-lane movements have not been inferred yet (multi lane approach without turn lanes).
   osm-node:1575311283: 4 road arms meet here; lane-to-lane movements have not been inferred yet (multi lane approach without turn lanes).

21. Hvarska ulica × Radnička cesta × Ulica grada Vukovara (osm-node:11915872120)
   22 lanes, 6 arms; 16.004281849999998, 45.801532249999994
   osm-node:11915872120: 4 road arms meet here; 2 of 3 approaches are still undecided (receiving lane undetermined).

22. I. Petruševec × Žitnjak (osm-node:5273151730, osm-node:6030702956)
   22 lanes, 7 arms; 16.0599015, 45.77571576666667
   osm-node:5273151730: 4 road arms meet here; 2 of 3 approaches are still undecided (multi lane approach without turn lanes).
   osm-node:6030702956: 4 road arms meet here; 2 of 3 approaches are still undecided (receiving lane undetermined).

23. Ilovička ulica × Južna ulica × Južna ulica VII. odvojak × Južna ulica VIII. odvojak × Ulica Željka Jukića × Čulinečka cesta (osm-node:8494222592)
   66 lanes, 16 arms; 16.06309450769231, 45.82234071538463
   osm-node:8494222592: 3 road arms meet here; 1 of 3 approaches are still undecided (receiving lane undetermined).

24. Jadranska avenija (osm-node:1828383616)
   8 lanes, 3 arms; 15.8951285, 45.7572059
   osm-node:1828383616: 3 road arms meet here; lane-to-lane movements have not been inferred yet (receiving lane undetermined).

25. Jarek donji × Jarek gornji × Jarek podsusedski (osm-node:1366167272, osm-node:4407137349, osm-node:7328967281)
   63 lanes, 12 arms; 15.825256847619048, 45.837824014285715
   osm-node:1366167272: 4 road arms meet here; 1 of 3 approaches are still undecided (approach reaches nothing).
   osm-node:4407137349: 4 road arms meet here; 1 of 2 approaches are still undecided (approach reaches nothing).
   osm-node:7328967281: 4 road arms meet here; 1 of 2 approaches are still undecided (approach reaches nothing).

26. Junction 1604026836 (osm-node:4204350494)
   11 lanes, 3 arms; 15.960575966666667, 45.7985682
   osm-node:4204350494: 3 road arms meet here; lane-to-lane movements have not been inferred yet (fewer than three arms).

27. Junction 2107295692 (osm-node:2107295699)
   13 lanes, 6 arms; 16.16688225, 45.795749099999995
   osm-node:2107295699: 3 road arms meet here; lane-to-lane movements have not been inferred yet (multi lane approach without turn lanes).

28. Junction 3015497911 (osm-node:3741907138)
   86 lanes, 22 arms; 16.15639888095238, 45.79345547142857
   osm-node:3741907138: 4 road arms meet here; 1 of 4 approaches are still undecided (multi lane approach without turn lanes).

29. Junction 3415873442 (osm-node:5277358694, osm-node:9993752704)
   183 lanes, 22 arms; 15.986950659183675, 45.75528389183673
   osm-node:5277358694: 4 road arms meet here; 1 of 4 approaches are still undecided (multi lane approach without turn lanes).
   osm-node:9993752704: 3 road arms meet here; lane-to-lane movements have not been inferred yet (multi lane approach without turn lanes).

30. Junction 582847441 (osm-node:582847441, osm-node:582847442, osm-node:582847443, osm-node:1617879344, osm-node:2680481809, osm-node:3365862025, osm-node:3365862027, osm-node:3814257808, osm-node:11347208736)
   55 lanes, 23 arms; 15.992319044999997, 45.803326610000006
   osm-node:582847441: 3 road arms meet here; lane-to-lane movements have not been inferred yet (receiving lane undetermined).
   osm-node:582847442: 3 road arms meet here; lane-to-lane movements have not been inferred yet (receiving lane undetermined).
   osm-node:582847443: 3 road arms meet here; lane-to-lane movements have not been inferred yet (receiving lane undetermined).
   osm-node:1617879344: 3 road arms meet here; lane-to-lane movements have not been inferred yet (receiving lane undetermined).
   osm-node:2680481809: 3 road arms meet here; lane-to-lane movements have not been inferred yet (receiving lane undetermined).
   osm-node:3365862025: 3 road arms meet here; lane-to-lane movements have not been inferred yet (receiving lane undetermined).
   osm-node:3365862027: 3 road arms meet here; lane-to-lane movements have not been inferred yet (receiving lane undetermined).
   osm-node:3814257808: 3 road arms meet here; lane-to-lane movements have not been inferred yet (receiving lane undetermined).
   osm-node:11347208736: 3 road arms meet here; lane-to-lane movements have not been inferred yet (receiving lane undetermined).

31. Junction 8725419832 (osm-node:8725419832)
   8 lanes, 3 arms; 16.2279914, 45.7915852
   osm-node:8725419832: 3 road arms meet here; lane-to-lane movements have not been inferred yet (unassigned incoming lane).

32. Klarići × Ulica Antuna Vugrina × Ulica Dane Grubera × Ulica svetog Ivana (osm-node:595591643)
   27 lanes, 6 arms; 16.118717224999997, 45.8017155
   osm-node:595591643: 3 road arms meet here; lane-to-lane movements have not been inferred yet (receiving lane undetermined).

33. Koledovčina × Radnička cesta (osm-node:8406423429)
   19 lanes, 5 arms; 16.034387199999998, 45.78870595
   osm-node:8406423429: 4 road arms meet here; 2 of 3 approaches are still undecided (receiving lane undetermined).

34. Krivajska ulica × Kruge × Njivice II. × Njivice III. × Njivice IV. × Njivice V. × Njivice VI. × Pile I. × Pile II. × Pile III. × Rujnička ulica × Slavonska avenija × Ulica Cvijete Zuzorić (osm-node:11961074584)
   132 lanes, 29 arms; 15.99128922121212, 45.795948630303045
   osm-node:11961074584: 4 road arms meet here; 1 of 6 approaches are still undecided (unassigned incoming lane).

35. Ljubljanska avenija (osm-node:307975207)
   6 lanes, 3 arms; 15.8816667, 45.797283
   osm-node:307975207: 3 road arms meet here; lane-to-lane movements have not been inferred yet (multi lane approach without turn lanes).

36. Ljubljanska avenija × Svilkovići × Zagrebačka avenija (osm-node:12610559628)
   28 lanes, 7 arms; 15.8922172, 45.797273233333335
   osm-node:12610559628: 4 road arms meet here; 1 of 6 approaches are still undecided (unassigned incoming lane).

37. Maškunjka (osm-node:7259121201)
   19 lanes, 8 arms; 15.823504583333337, 45.8778044
   osm-node:7259121201: 3 road arms meet here; 1 of 2 approaches are still undecided (multi lane approach without turn lanes).

38. Obala dr. Savke Dabčević Kučar × Savska cesta (osm-node:1425179900, osm-node:1425179902, osm-node:2798430609, osm-node:2798430611, osm-node:2798430704, osm-node:2798430801, osm-node:2798430802, osm-node:2798430914, osm-node:2798431206, osm-node:7271693056, osm-node:11519219973, osm-node:11731412955)
   44 lanes, 12 arms; 15.952968683333333, 45.785313822222214
   osm-node:1425179900: 4 road arms meet here; lane-to-lane movements have not been inferred yet (receiving lane undetermined).
   osm-node:1425179902: 3 road arms meet here; lane-to-lane movements have not been inferred yet (receiving lane undetermined).
   osm-node:2798430609: 3 road arms meet here; lane-to-lane movements have not been inferred yet (receiving lane undetermined).
   osm-node:2798430611: 3 road arms meet here; lane-to-lane movements have not been inferred yet (receiving lane undetermined).
   osm-node:2798430704: 3 road arms meet here; lane-to-lane movements have not been inferred yet (receiving lane undetermined).
   osm-node:2798430801: 3 road arms meet here; lane-to-lane movements have not been inferred yet (receiving lane undetermined).
   osm-node:2798430802: 3 road arms meet here; lane-to-lane movements have not been inferred yet (receiving lane undetermined).
   osm-node:2798430914: 3 road arms meet here; lane-to-lane movements have not been inferred yet (receiving lane undetermined).
   osm-node:2798431206: 3 road arms meet here; lane-to-lane movements have not been inferred yet (receiving lane undetermined).
   osm-node:7271693056: 3 road arms meet here; lane-to-lane movements have not been inferred yet (receiving lane undetermined).
   osm-node:11519219973: 3 road arms meet here; lane-to-lane movements have not been inferred yet (receiving lane undetermined).
   osm-node:11731412955: 3 road arms meet here; lane-to-lane movements have not been inferred yet (receiving lane undetermined).

39. Prisavlje × Ulica Josipa Marohnića (osm-node:10948881766)
   49 lanes, 15 arms; 15.969421169999999, 45.79156599
   osm-node:10948881766: 4 road arms meet here; 2 of 4 approaches are still undecided (multi lane approach without turn lanes).

40. Radnička cesta × Ulica Vjekoslava Heinzela (osm-node:1240287532)
   45 lanes, 9 arms; 16.0188091125, 45.796539787499995
   osm-node:1240287532: 4 road arms meet here; lane-to-lane movements have not been inferred yet (approach reaches nothing).

41. Sarajevska cesta × Ukrajinska ulica (osm-node:319170829)
   13 lanes, 7 arms; 16.0039223, 45.773364
   osm-node:319170829: 7 road arms meet here; 2 of 4 approaches are still undecided (ambiguous arm for turn).

42. Savska cesta (osm-node:3767171458)
   52 lanes, 12 arms; 15.959398512499998, 45.7950995
   osm-node:3767171458: 3 road arms meet here; lane-to-lane movements have not been inferred yet (receiving lane undetermined).

43. Slavonska avenija × Ulica Josipa Marohnića × Vrbik XIII. (osm-node:10915887858)
   52 lanes, 13 arms; 15.969000957142857, 45.7943072
   osm-node:10915887858: 4 road arms meet here; lane-to-lane movements have not been inferred yet (unassigned incoming lane).

44. Trg Drage Iblera × Ulica Ivana Vončine × Vlaška ulica (osm-node:11339296572)
   101 lanes, 24 arms; 15.985802911764706, 45.813727582352946
   osm-node:11339296572: 3 road arms meet here; 1 of 2 approaches are still undecided (unassigned incoming lane).

45. Ulica 2. gardijske brigade "Gromovi" × Ulica platana × Čulinečka cesta (osm-node:1964959627)
   26 lanes, 5 arms; 16.064151925, 45.82302742499999
   osm-node:1964959627: 3 road arms meet here; 1 of 3 approaches are still undecided (unassigned incoming lane).

46. Ulica Ante Starčevića × Ulica Pavla Lončara (osm-node:12297085512)
   63 lanes, 12 arms; 15.798996352380955, 45.85980452380953
   osm-node:12297085512: 3 road arms meet here; 1 of 2 approaches are still undecided (unassigned incoming lane).

47. Ulica dr. Franje Tuđmana × Ulica kralja Tomislava (osm-node:5797924310)
   97 lanes, 17 arms; 15.786781543333335, 45.801506296666666
   osm-node:5797924310: 3 road arms meet here; 1 of 2 approaches are still undecided (multi lane approach without turn lanes).

48. Ulica Frana Krste Frankopana × Ulica I. gardijske brigade Tigrovi × Ulica grada Chicaga (osm-node:319188298)
   24 lanes, 7 arms; 16.008878399999997, 45.78951323333333
   osm-node:319188298: 4 road arms meet here; 2 of 4 approaches are still undecided (multi lane approach without turn lanes).

49. Ulica Gustava Krkleca × Ulica Josipa Slavenskog × Zagrebačka avenija (osm-node:19718788, osm-node:20300049)
   39 lanes, 7 arms; 15.899915340000002, 45.79682604
   osm-node:19718788: 4 road arms meet here; 2 of 3 approaches are still undecided (receiving lane undetermined).
   osm-node:20300049: 4 road arms meet here; 1 of 7 approaches are still undecided (unassigned incoming lane).

50. Ulica Josipa Hanuša (osm-node:1358331368)
   10 lanes, 3 arms; 15.9561106, 45.8093721
   osm-node:1358331368: 3 road arms meet here; lane-to-lane movements have not been inferred yet (receiving lane undetermined).

51. Ulica kneza Branimira × Zavrtnica (osm-node:8412771793)
   32 lanes, 11 arms; 15.999384225, 45.808250275
   osm-node:8412771793: 4 road arms meet here; 1 of 6 approaches are still undecided (unassigned incoming lane).

52. Ulica Ljudevita Posavskog (osm-node:13071066748, osm-node:13071066749)
   15 lanes, 6 arms; 16.10074355, 45.806325900000004
   osm-node:13071066748: 4 road arms meet here; lane-to-lane movements have not been inferred yet (receiving lane undetermined).
   osm-node:13071066749: 4 road arms meet here; lane-to-lane movements have not been inferred yet (receiving lane undetermined).

53. Ulica Mije Haleuša (osm-node:13071066751)
   14 lanes, 6 arms; 16.1007842, 45.80592645
   osm-node:13071066751: 4 road arms meet here; lane-to-lane movements have not been inferred yet (receiving lane undetermined).

54. Ulica Mije Šiloboda Bolšića (osm-node:13479333351)
   42 lanes, 8 arms; 15.988754430769232, 45.76400183846154
   osm-node:13479333351: 3 road arms meet here; 1 of 2 approaches are still undecided (unassigned incoming lane).

55. Ulica Rudolfa Fizira (osm-node:2366202020, osm-node:3247824552)
   32 lanes, 8 arms; 16.100086583333333, 45.75602261666666
   osm-node:2366202020: 4 road arms meet here; 1 of 2 approaches are still undecided (unassigned incoming lane).
   osm-node:3247824552: 4 road arms meet here; lane-to-lane movements have not been inferred yet (multi lane approach without turn lanes).

56. Ulica Savezne Republike Njemačke × Vatikanska ulica (osm-node:319161641)
   35 lanes, 6 arms; 15.991011400000001, 45.767901849999994
   osm-node:319161641: 4 road arms meet here; lane-to-lane movements have not been inferred yet (multi lane approach without turn lanes).

57. Ulica Vjekoslava Heinzela × Ulica kneza Branimira × Zavrtnica (osm-node:25323107, osm-node:27434593, osm-node:3892413566)
   57 lanes, 13 arms; 16.003674422222222, 45.808847377777774
   osm-node:25323107: 4 road arms meet here; lane-to-lane movements have not been inferred yet (receiving lane undetermined).
   osm-node:27434593: 4 road arms meet here; lane-to-lane movements have not been inferred yet (receiving lane undetermined).
   osm-node:3892413566: 4 road arms meet here; lane-to-lane movements have not been inferred yet (receiving lane undetermined).
